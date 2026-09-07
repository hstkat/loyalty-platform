const fs = require('fs');
const path = require('path');

const files = [
  'backoffice/transacties.html',
  'backoffice/gift-cards.html',
  'backoffice/inschrijven.html',
  'backoffice/loyalty-cards.html',
  'backoffice/instellingen.html',
];

let totalReplacements = 0;

files.forEach((relPath) => {
  const filePath = path.join(__dirname, relPath);
  if (!fs.existsSync(filePath)) {
    console.error(`Overgeslagen (niet gevonden): ${relPath}`);
    return;
  }
  let content = fs.readFileSync(filePath, 'utf8');
  const matches = (content.match(/} catch \{/g) || []).length;
  if (matches === 0) {
    console.log(`${relPath}: niets te doen (0 gevonden)`);
    return;
  }
  content = content.split('} catch {').join('} catch (err) {');
  fs.writeFileSync(filePath, content, 'utf8');
  totalReplacements += matches;
  console.log(`${relPath}: ${matches}x gefixt`);
});

console.log(`\nGelukt: ${totalReplacements} plekken aangepast — nu compatibel met oudere browsers (o.a. Sunmi-kassaterminals).`);