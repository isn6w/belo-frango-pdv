// Configuração do banco de dados SQLite
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const isVercel = Boolean(process.env.VERCEL || process.env.VERCEL_ENV || process.env.AWS_LAMBDA_FUNCTION_NAME);
const dbPath = process.env.DB_PATH || (isVercel
  ? path.join('/tmp', 'belo-frango.db')
  : path.join(__dirname, 'data', 'belo-frango.db'));

// Cria o diretório de dados se não existir
const dataDir = path.dirname(dbPath);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Abre a conexão com o banco de dados
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Erro ao conectar ao banco de dados:', err.message);
  } else {
    console.log('Conectado ao banco de dados SQLite');
  }
});

// Configurações do banco
db.run('PRAGMA foreign_keys = ON');

let initialized = false;

// Função para executar migrations
function initialize() {
  if (initialized) return;
  initialized = true;

  db.serialize(() => {
  // Tabela de usuários (vendedores)
  db.run(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      nome TEXT NOT NULL,
      cargo TEXT DEFAULT 'vendedor',
      ativo INTEGER DEFAULT 1,
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Tabela de clientes
  db.run(`
    CREATE TABLE IF NOT EXISTS clientes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo TEXT UNIQUE NOT NULL,
      nome TEXT NOT NULL,
      cpf_cnpj TEXT,
      telefone TEXT,
      email TEXT,
      endereco TEXT,
      pontos INTEGER DEFAULT 0,
      valor_total_compras REAL DEFAULT 0,
      fiado REAL DEFAULT 0,
      ativo INTEGER DEFAULT 1,
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
      atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Tabela de produtos
  db.run(`
    CREATE TABLE IF NOT EXISTS produtos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo TEXT UNIQUE NOT NULL,
      nome TEXT NOT NULL,
      descricao TEXT,
      categoria TEXT DEFAULT 'Outros',
      preco_venda REAL NOT NULL,
      preco_custo REAL DEFAULT 0,
      quantidade_estoque REAL DEFAULT 0,
      unidade TEXT DEFAULT 'kg',
      estoque_minimo INTEGER DEFAULT 5,
      ativo INTEGER DEFAULT 1,
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
      atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Tabela de vendas
  db.run(`
    CREATE TABLE IF NOT EXISTS vendas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo_venda TEXT UNIQUE NOT NULL,
      id_vendedor INTEGER NOT NULL,
      id_cliente INTEGER,
      forma_pagamento TEXT NOT NULL,
      tipo_pagamento TEXT,
      valor_total REAL NOT NULL,
      valor_pago REAL DEFAULT 0,
      valor_troco REAL DEFAULT 0,
      status TEXT DEFAULT 'finalizada',
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (id_vendedor) REFERENCES usuarios(id),
      FOREIGN KEY (id_cliente) REFERENCES clientes(id)
    )
  `);

  // Tabela de itens da venda
  db.run(`
    CREATE TABLE IF NOT EXISTS itens_venda (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      id_venda INTEGER NOT NULL,
      id_produto INTEGER NOT NULL,
      nome_produto TEXT NOT NULL,
      codigo_produto TEXT NOT NULL,
      quantidade REAL NOT NULL,
      preco_unitario REAL NOT NULL,
      total_item REAL NOT NULL,
      FOREIGN KEY (id_venda) REFERENCES vendas(id),
      FOREIGN KEY (id_produto) REFERENCES produtos(id)
    )
  `);

  // Tabela de pagamentos (para QR Code PIX/PicPay)
  db.run(`
    CREATE TABLE IF NOT EXISTS pagamentos_qr (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chave TEXT NOT NULL,
      valor REAL NOT NULL,
      descricao TEXT,
      qrcode_image TEXT,
      pago INTEGER DEFAULT 0,
      data_pagamento DATETIME,
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Tabela de configurações
  db.run(`
    CREATE TABLE IF NOT EXISTS configuracoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chave TEXT UNIQUE NOT NULL,
      valor TEXT NOT NULL,
      descricao TEXT
    )
  `);

  // Armazena o estado usado pela interface atual (produtos, clientes, vendas e configurações).
  db.run(`
    CREATE TABLE IF NOT EXISTS app_storage (
      chave TEXT PRIMARY KEY,
      valor TEXT NOT NULL,
      atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Cria usuário padrão se não existir
  db.get('SELECT id FROM usuarios WHERE username = ?', ['yuri'], (err, row) => {
    if (!row) {
      const bcrypt = require('bcrypt');
      const senhaHash = bcrypt.hashSync('123', 10);
      db.run(
        'INSERT INTO usuarios (username, password, nome, cargo) VALUES (?, ?, ?, ?)',
        ['yuri', senhaHash, 'Yuri', 'vendedor'],
        (err) => {
          if (err) {
            console.log('Erro ao criar usuário padrão:', err.message);
          } else {
            console.log('Usuário padrão Yuri criado com sucesso!');
          }
        }
      );
    }
  });

  // Insere configurações padrão se não existirem
  const configs = [
    ['empresa_nome', 'Belo Frango', 'Nome da empresa'],
    ['empresa_cnpj', '', 'CNPJ da empresa'],
    ['empresa_endereco', '', 'Endereço da empresa'],
    ['pix_chave', '', 'Chave PIX para pagamentos'],
    ['picpay_chave', '', 'Chave PicPay para pagamentos']
  ];

  configs.forEach(([chave, valor, descricao]) => {
    db.get('SELECT id FROM configuracoes WHERE chave = ?', [chave], (err, row) => {
      if (!row) {
        db.run(
          'INSERT INTO configuracoes (chave, valor, descricao) VALUES (?, ?, ?)',
          [chave, valor, descricao]
        );
      }
    });
  });
  });
}

// Exporta a conexão
module.exports = { db, initialize };
