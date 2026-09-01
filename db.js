const sqlite3 = require('sqlite3').verbose();
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

const isServerlessRuntime = Boolean(process.env.VERCEL || process.env.VERCEL_ENV || process.env.AWS_LAMBDA_FUNCTION_NAME);

if (process.env.NODE_ENV === 'production' && !process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL não configurada. Configure a conexão do Neon no ambiente de produção.');
}

function normalizeQuery(sql, params = []) {
  const values = Array.isArray(params) ? params : [params];
  let positionalIndex = 0;
  const query = sql.replace(/\?/g, () => {
    positionalIndex += 1;
    return `$${positionalIndex}`;
  });
  return { text: query, values };
}

function createPostgresDb() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
      ? { rejectUnauthorized: false }
      : false,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });

  const db = {
    provider: 'postgres',
    _pool: pool,
    pool,
    serialize(fn) {
      fn();
    },
    get(sql, params, callback) {
      if (typeof params === 'function') {
        callback = params;
        params = [];
      }
      const { text, values } = normalizeQuery(sql, params);
      pool.query(text, values, (err, result) => {
        if (callback) callback(err, err ? null : (result && result.rows ? result.rows[0] || null : null));
      });
    },
    all(sql, params, callback) {
      if (typeof params === 'function') {
        callback = params;
        params = [];
      }
      const { text, values } = normalizeQuery(sql, params);
      pool.query(text, values, (err, result) => {
        if (callback) callback(err, err ? null : (result && result.rows ? result.rows : []));
      });
    },
    run(sql, params, callback) {
      if (typeof params === 'function') {
        callback = params;
        params = [];
      }
      const { text, values } = normalizeQuery(sql, params);
      pool.query(text, values, (err, result) => {
        if (callback) {
          const context = {
            lastID: result && result.rows && result.rows[0] && result.rows[0].id ? result.rows[0].id : null,
            changes: result ? result.rowCount || 0 : 0
          };
          callback.call(context, err, result);
        }
      });
    },
    prepare(sql) {
      return {
        run: (...args) => {
          const lastArg = args[args.length - 1];
          const callback = typeof lastArg === 'function' ? lastArg : null;
          const finalArgs = callback ? args.slice(0, -1) : args;
          const { text, values } = normalizeQuery(sql, finalArgs);
          return new Promise((resolve, reject) => {
            pool.query(text, values, (err, result) => {
              if (callback) callback.call({ lastID: result && result.rows && result.rows[0] ? result.rows[0].id : null, changes: result ? result.rowCount || 0 : 0 }, err, result);
              if (err) return reject(err);
              resolve(result);
            });
          });
        },
        finalize() {}
      };
    }
  };

  return db;
}

function createSqliteDb() {
  const dbPath = process.env.DB_PATH || (isServerlessRuntime ? path.join('/tmp', 'belo-frango.db') : path.join(__dirname, 'data', 'belo-frango.db'));
  const dataDir = path.dirname(dbPath);

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const seedDbPath = path.join(__dirname, 'data', 'belo-frango.db');
  if (path.resolve(dbPath) !== path.resolve(seedDbPath) && !fs.existsSync(dbPath) && fs.existsSync(seedDbPath)) {
    fs.copyFileSync(seedDbPath, dbPath);
    console.log('Banco de dados semeado a partir de', seedDbPath, '->', dbPath);
  }

  const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
      console.error('Erro ao conectar ao banco de dados:', err.message);
    } else {
      console.log('Conectado ao banco de dados SQLite');
    }
  });

  db.run('PRAGMA foreign_keys = ON');
  db.provider = 'sqlite';
  return db;
}

const db = process.env.DATABASE_URL ? createPostgresDb() : createSqliteDb();

let initialized = false;

function initializeSqlite() {
  db.serialize(() => {
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

    db.run(`
      CREATE TABLE IF NOT EXISTS configuracoes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chave TEXT UNIQUE NOT NULL,
        valor TEXT NOT NULL,
        descricao TEXT
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS app_storage (
        chave TEXT PRIMARY KEY,
        valor TEXT NOT NULL,
        atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    db.get('SELECT valor FROM app_storage WHERE chave = ?', ['setup_usuarios_historico_v1'], (err, row) => {
      if (err || row) return;
      const bcrypt = require('bcrypt');
      const usuarios = [
        ['yuri', 'yuri2026', 'Yuri'],
        ['vanessa', 'vanessa2026', 'Vanessa'],
        ['flavio', 'flavio2026', 'Flavio']
      ];
      db.serialize(() => {
        db.run('DELETE FROM itens_venda');
        db.run('DELETE FROM vendas');
        db.run('DELETE FROM usuarios');
        db.run('DELETE FROM app_storage WHERE chave IN (?, ?, ?, ?, ?, ?)', ['vendas', 'boletos', 'notasImportadas', 'caixa', 'vendedores', 'pdv_snapshot']);
        usuarios.forEach(([username, senha, nome]) => {
          db.run('INSERT INTO usuarios (username, password, nome, cargo) VALUES (?, ?, ?, ?)', [username, bcrypt.hashSync(senha, 10), nome, 'vendedor']);
        });
        db.run('INSERT INTO app_storage (chave, valor) VALUES (?, ?)', ['setup_usuarios_historico_v1', 'concluido']);
      });
    });

    const configs = [
      ['empresa_nome', 'Belo Frango', 'Nome da empresa'],
      ['empresa_cnpj', '', 'CNPJ da empresa'],
      ['empresa_endereco', '', 'Endereço da empresa'],
      ['pix_chave', '', 'Chave PIX para pagamentos'],
      ['picpay_chave', '', 'Chave PicPay para pagamentos']
    ];

    configs.forEach(([chave, valor, descricao]) => {
      db.get('SELECT id FROM configuracoes WHERE chave = ?', [chave], (err, row) => {
        if (!err && !row) {
          db.run(
            'INSERT INTO configuracoes (chave, valor, descricao) VALUES (?, ?, ?)',
            [chave, valor, descricao]
          );
        }
      });
    });
  });
}

async function initializePostgres() {
  const client = await db._pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id BIGSERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        nome TEXT NOT NULL,
        cargo TEXT DEFAULT 'vendedor',
        ativo INTEGER DEFAULT 1,
        criado_em TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS clientes (
        id BIGSERIAL PRIMARY KEY,
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
        criado_em TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        atualizado_em TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS produtos (
        id BIGSERIAL PRIMARY KEY,
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
        criado_em TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        atualizado_em TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS vendas (
        id BIGSERIAL PRIMARY KEY,
        codigo_venda TEXT UNIQUE NOT NULL,
        id_vendedor BIGINT NOT NULL,
        id_cliente BIGINT,
        forma_pagamento TEXT NOT NULL,
        tipo_pagamento TEXT,
        valor_total REAL NOT NULL,
        valor_pago REAL DEFAULT 0,
        valor_troco REAL DEFAULT 0,
        status TEXT DEFAULT 'finalizada',
        criado_em TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (id_vendedor) REFERENCES usuarios(id),
        FOREIGN KEY (id_cliente) REFERENCES clientes(id)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS itens_venda (
        id BIGSERIAL PRIMARY KEY,
        id_venda BIGINT NOT NULL,
        id_produto BIGINT NOT NULL,
        nome_produto TEXT NOT NULL,
        codigo_produto TEXT NOT NULL,
        quantidade REAL NOT NULL,
        preco_unitario REAL NOT NULL,
        total_item REAL NOT NULL,
        FOREIGN KEY (id_venda) REFERENCES vendas(id),
        FOREIGN KEY (id_produto) REFERENCES produtos(id)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS pagamentos_qr (
        id BIGSERIAL PRIMARY KEY,
        chave TEXT NOT NULL,
        valor REAL NOT NULL,
        descricao TEXT,
        qrcode_image TEXT,
        pago INTEGER DEFAULT 0,
        data_pagamento TIMESTAMPTZ,
        criado_em TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS configuracoes (
        id BIGSERIAL PRIMARY KEY,
        chave TEXT UNIQUE NOT NULL,
        valor TEXT NOT NULL,
        descricao TEXT
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS app_storage (
        chave TEXT PRIMARY KEY,
        valor TEXT NOT NULL,
        atualizado_em TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const setup = await client.query('SELECT valor FROM app_storage WHERE chave = $1', ['setup_usuarios_historico_v1']);
    if (setup.rowCount === 0) {
      const bcrypt = require('bcrypt');
      await client.query('BEGIN');
      try {
        await client.query('DELETE FROM itens_venda');
        await client.query('DELETE FROM vendas');
        await client.query('DELETE FROM usuarios');
        await client.query("DELETE FROM app_storage WHERE chave IN ('vendas', 'boletos', 'notasImportadas', 'caixa', 'vendedores', 'pdv_snapshot')");
        for (const [username, senha, nome] of [['yuri', 'yuri2026', 'Yuri'], ['vanessa', 'vanessa2026', 'Vanessa'], ['flavio', 'flavio2026', 'Flavio']]) {
          await client.query('INSERT INTO usuarios (username, password, nome, cargo) VALUES ($1, $2, $3, $4)', [username, bcrypt.hashSync(senha, 10), nome, 'vendedor']);
        }
        await client.query('INSERT INTO app_storage (chave, valor) VALUES ($1, $2)', ['setup_usuarios_historico_v1', 'concluido']);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }

    const configs = [
      ['empresa_nome', 'Belo Frango', 'Nome da empresa'],
      ['empresa_cnpj', '', 'CNPJ da empresa'],
      ['empresa_endereco', '', 'Endereço da empresa'],
      ['pix_chave', '', 'Chave PIX para pagamentos'],
      ['picpay_chave', '', 'Chave PicPay para pagamentos']
    ];

    for (const [chave, valor, descricao] of configs) {
      const existente = await client.query('SELECT id FROM configuracoes WHERE chave = $1', [chave]);
      if (existente.rowCount === 0) {
        await client.query(
          'INSERT INTO configuracoes (chave, valor, descricao) VALUES ($1, $2, $3)',
          [chave, valor, descricao]
        );
      }
    }

    console.log('Conectado ao banco de dados PostgreSQL (Neon)');
  } finally {
    client.release();
  }
}

function initialize() {
  if (initialized) return;
  initialized = true;

  if (process.env.DATABASE_URL) {
    if (!db._pool) {
      db._pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
          ? { rejectUnauthorized: false }
          : false,
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000
      });
      db.pool = db._pool;
    }
    return initializePostgres();
  }

  return initializeSqlite();
}

module.exports = { db, initialize };
