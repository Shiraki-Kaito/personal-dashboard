const [major,minor,patch] = process.versions.node.split('.').map(Number);
if (major !== 24 || minor < 22 || minor === 22 && patch < 3) {
  console.error('この候補は修正版Node.js 24.22.3以上の24系で検証してください。security/operations.mdを参照。');
  process.exit(1);
}
