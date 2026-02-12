const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'src');
const dist = path.join(__dirname, '..', 'dist');

// Copy schema.sql
fs.copyFileSync(
  path.join(src, 'db', 'schema.sql'),
  path.join(dist, 'db', 'schema.sql')
);
console.log('  Copied db/schema.sql');

// Copy instruction files
const instrSrc = path.join(src, 'instructions');
const instrDist = path.join(dist, 'instructions');
if (!fs.existsSync(instrDist)) {
  fs.mkdirSync(instrDist, { recursive: true });
}

for (const file of fs.readdirSync(instrSrc)) {
  if (file.endsWith('.md')) {
    fs.copyFileSync(path.join(instrSrc, file), path.join(instrDist, file));
    console.log(`  Copied instructions/${file}`);
  }
}

console.log('Assets copied to dist/');
