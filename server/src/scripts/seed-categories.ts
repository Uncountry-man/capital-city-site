// Cria as categorias iniciais da loja (pode ser executado mais de uma vez; não duplica).
// Os produtos são cadastrados pelo painel administrativo.
import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';

const CATEGORIES = [
  { slug: 'vip', name: 'VIP', icon: 'crown', description: 'Planos VIP com vantagens exclusivas na cidade.' },
  { slug: 'moedas', name: 'Moedas', icon: 'coins', description: 'Créditos para usar dentro do servidor.' },
  { slug: 'veiculos', name: 'Veículos', icon: 'car', description: 'Carros, motos e utilitários exclusivos.' },
  { slug: 'propriedades', name: 'Propriedades', icon: 'home', description: 'Casas e empresas.' },
  { slug: 'itens', name: 'Itens', icon: 'box', description: 'Itens para o inventário.' },
  { slug: 'beneficios', name: 'Benefícios', icon: 'star', description: 'Vantagens e serviços da conta.' },
  { slug: 'personalizacoes', name: 'Personalizações', icon: 'palette', description: 'Skins e visuais.' },
  { slug: 'pacotes', name: 'Pacotes', icon: 'gift', description: 'Combos promocionais.' },
];

const config = loadConfig();
const db = createPool(config.databaseUrl, config.databaseSsl);
try {
  for (const [i, c] of CATEGORIES.entries()) {
    await db.query(
      `INSERT INTO categories (slug, name, icon, description, sort_order) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (slug) DO NOTHING`,
      [c.slug, c.name, c.icon, c.description, i * 10],
    );
  }
  console.log('Categorias criadas.');
} finally {
  await db.end();
}
