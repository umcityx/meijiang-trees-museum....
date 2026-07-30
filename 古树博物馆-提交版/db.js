/**
 * 数据库层：better-sqlite3 建库、建表、首次启动迁移 data.js
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
require('dotenv').config();

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'museum.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS trees (
  id INTEGER PRIMARY KEY,
  name TEXT,
  otherName TEXT,
  latinName TEXT,
  family TEXT,
  genus TEXT,
  level TEXT,
  age TEXT,
  estimateAge INTEGER,
  location TEXT,
  lat REAL,
  lng REAL,
  height TEXT,
  dbh TEXT,
  canopy TEXT,
  feature TEXT,
  manageUnit TEXT,
  protectionMeasures TEXT,
  maintenance TEXT,
  description TEXT,
  image TEXT,
  gallery TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT,
  path TEXT,
  ua TEXT,
  day TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  author TEXT,
  content TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS favorites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  tree_id INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, tree_id),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(tree_id) REFERENCES trees(id) ON DELETE CASCADE
);
`);

// 兼容字段：pointcloud 存 3D 点云 .ply 的访问路径（如 /pointclouds/54.ply）
try {
  const cols = db.prepare('PRAGMA table_info(trees)').all().map(c => c.name);
  if (!cols.includes('pointcloud')) {
    db.exec('ALTER TABLE trees ADD COLUMN pointcloud TEXT');
    console.log('[migrate] trees 表新增 pointcloud 字段');
  }
} catch (e) {
  console.warn('[migrate] 检查/新增 pointcloud 字段失败:', e.message);
}

/** 首次启动把 public/js/data.js 的 118 棵迁进库，并建默认管理员 */
function migrate() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM trees').get().c;
  if (count === 0) {
    let treesData = [];
    try {
      const dp = path.join(__dirname, 'public', 'js', 'data.js');
      delete require.cache[require.resolve(dp)];
      treesData = require(dp).treesData || [];
    } catch (e) {
      console.warn('[migrate] 读取 data.js 失败:', e.message);
    }
    if (treesData.length) {
      const insert = db.prepare(`INSERT OR REPLACE INTO trees
        (id,name,otherName,latinName,family,genus,level,age,estimateAge,location,lat,lng,height,dbh,canopy,feature,manageUnit,protectionMeasures,maintenance,description,image,gallery)
        VALUES (@id,@name,@otherName,@latinName,@family,@genus,@level,@age,@estimateAge,@location,@lat,@lng,@height,@dbh,@canopy,@feature,@manageUnit,@protectionMeasures,@maintenance,@description,@image,@gallery)`);
      const insertMany = db.transaction((rows) => {
        for (const t of rows) {
          insert.run({
            id: t.id, name: t.name, otherName: t.otherName, latinName: t.latinName,
            family: t.family, genus: t.genus, level: t.level, age: t.age,
            estimateAge: t.estimateAge, location: t.location, lat: t.lat, lng: t.lng,
            height: t.height, dbh: t.dbh, canopy: t.canopy, feature: t.feature,
            manageUnit: t.manageUnit, protectionMeasures: t.protectionMeasures,
            maintenance: t.maintenance, description: t.description, image: t.image,
            gallery: JSON.stringify(t.gallery || []),
          });
        }
      });
      insertMany(treesData);
      console.log(`[migrate] 已迁移 ${treesData.length} 棵古树到数据库`);
    }
  }

  // 默认管理员（仅当无账号时）
  const uc = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (uc === 0) {
    const bcrypt = require('bcryptjs');
    const hash = bcrypt.hashSync('060320', 10);
    db.prepare('INSERT INTO users (username,password_hash,role) VALUES (?,?,?)').run('umcityx', hash, 'admin');
    console.log('[init] 已创建默认管理员  umcityx / 060320  （请尽快修改密码）');
  }
}

migrate();

// 千年古梅(id=54) 点云：若已生成且记录为空则绑定（幂等）
try {
  const ply = path.join(__dirname, 'public', 'pointclouds', '54.ply');
  if (fs.existsSync(ply)) {
    db.prepare("UPDATE trees SET pointcloud=? WHERE id=? AND (pointcloud IS NULL OR pointcloud='')")
      .run('/pointclouds/54.ply', 54);
  }
} catch (e) {
  console.warn('[migrate] 绑定千年古梅点云失败:', e.message);
}

module.exports = db;
