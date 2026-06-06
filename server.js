require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const Stripe = require('stripe');
const Anthropic = require('@anthropic-ai/sdk');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3001;
app.use(cors());
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const stripe = process.env.STRIPE_KEY ? Stripe(process.env.STRIPE_KEY) : null;
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }) : null;

const AGENTS = [
  { id:'strategy', name:'Stratège',    emoji:'🧭', role:'Vision & Planification',
    tasks:['Analyse du marché et de la concurrence','Définition de la roadmap produit','Identification des opportunités de croissance','Modélisation du business model','Identification des partenariats stratégiques'] },
  { id:'dev',      name:'Développeur', emoji:'💻', role:'Code & Architecture',
    tasks:["Review de l'architecture technique",'Optimisation des performances','Identification des améliorations produit','Sécurité et bonnes pratiques','Mise à jour des dépendances'] },
  { id:'marketing',name:'Marketing',   emoji:'📣', role:'Croissance & Visibilité',
    tasks:['Stratégie de contenu pour les réseaux sociaux','Optimisation SEO','Analyse du profil client idéal',"Campagnes d'acquisition",'Stratégie de rétention clients'] },
  { id:'ops',      name:'Opérations',  emoji:'⚙️', role:'Organisation & Efficacité',
    tasks:['Automatisation des processus internes','Rapport de performance hebdomadaire','Optimisation des coûts','Mise en place des KPIs','Organisation et priorisation des tâches'] }
];

async function initDB() {
  if (!pool) return;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS agent_results (
      id SERIAL PRIMARY KEY, agent_id VARCHAR(50) NOT NULL,
      agent_name VARCHAR(100), agent_emoji VARCHAR(10),
      task VARCHAR(200), result TEXT, created_at TIMESTAMP DEFAULT NOW()
    );`);
    console.log('✅ Base de données initialisée');
  } catch(e) { console.error('❌ Erreur DB:', e.message); }
}

async function runAgent(agentId) {
  const agent = AGENTS.find(a => a.id === agentId);
  if (!agent) return;
  const task = agent.tasks[Math.floor(Math.random() * agent.tasks.length)];
  console.log(`🤖 ${agent.emoji} ${agent.name} → ${task}`);
  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514', max_tokens: 1000,
      messages: [{ role: 'user', content: `Tu es un agent IA autonome spécialisé en "${agent.role}" pour SmileOS, une startup innovante.\nTâche : ${task}\nProduis un résultat professionnel, concret et actionnable en français (4-5 phrases). Explique ce que tu as fait et ce que ça apporte à SmileOS. Parle simplement, comme un conseiller qui s'adresse au fondateur. Commence directement par le résultat.` }]
    });
    const result = message.content[0].text;
    if (pool) await pool.query('INSERT INTO agent_results (agent_id, agent_name, agent_emoji, task, result) VALUES ($1, $2, $3, $4, $5)', [agent.id, agent.name, agent.emoji, task, result]);
    console.log(`✅ ${agent.emoji} ${agent.name} → Terminé`);
    return { agent: agent.name, emoji: agent.emoji, task, result };
  } catch(e) { console.error(`❌ ${agent.name}:`, e.message); }
}

// Routes
app.get('/', (req, res) => res.json({ status: 'ok', message: '✅ SmileOS AI Backend actif 24h/24', agents: AGENTS.map(a => `${a.emoji} ${a.name}`) }));

app.get('/api/results', async (req, res) => {
  if (!pool) return res.json([]);
  try { const r = await pool.query('SELECT DISTINCT ON (agent_id) * FROM agent_results ORDER BY agent_id, created_at DESC'); res.json(r.rows); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/history', async (req, res) => {
  if (!pool) return res.json([]);
  try { const r = await pool.query('SELECT * FROM agent_results ORDER BY created_at DESC LIMIT 30'); res.json(r.rows); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/stats', async (req, res) => {
  if (!pool) return res.json({ total: 0 });
  try { const r = await pool.query('SELECT COUNT(*) as total FROM agent_results'); res.json({ total: parseInt(r.rows[0].total) }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/balance', async (req, res) => {
  if (!stripe) return res.json({ available: 0, pending: 0, currency: 'eur' });
  try {
    const balance = await stripe.balance.retrieve();
    res.json({ available: balance.available.reduce((s,b) => s+b.amount,0)/100, pending: balance.pending.reduce((s,b) => s+b.amount,0)/100, currency: 'eur' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ✅ NOUVEAU : Chat avec les agents
app.post('/api/chat', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Message requis' });
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514', max_tokens: 1000,
      messages: [{ role: 'user', content: `Tu es le coordinateur IA de SmileOS, une startup innovante.\nQuestion du fondateur : "${message}"\nRéponds clairement en français avec des emojis pour chaque point. 4-5 points maximum. Sois direct et utile.` }]
    });
    res.json({ reply: response.content[0].text });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/run/:agentId', async (req, res) => {
  const result = await runAgent(req.params.agentId);
  res.json(result || { error: 'Agent non trouvé' });
});

// Cron toutes les 2h
cron.schedule('0 */2 * * *',  () => runAgent('strategy'));
cron.schedule('15 */2 * * *', () => runAgent('dev'));
cron.schedule('30 */2 * * *', () => runAgent('marketing'));
cron.schedule('45 */2 * * *', () => runAgent('ops'));

initDB().then(() => {
  AGENTS.forEach((a, i) => setTimeout(() => runAgent(a.id), i * 4000));
  app.listen(PORT, () => {
    console.log(`\n✅ SmileOS AI lancé sur le port ${PORT}`);
    console.log(`🤖 4 agents actifs — mise à jour toutes les 2h\n`);
  });
});

});
