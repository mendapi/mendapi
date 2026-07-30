// Anchor-gate negative site: an in-house tuning table for vercel deploy
// workers. The file mentions vercel (the file-level guard passes), and the
// flag binding below is genuinely dead - but the right-hand side is a plain
// tuning row, not a resourceConfig chain. The anchor gate is the only
// defense: the whole file must stay byte-identical.
function workerCpu(row) {
  const { enableFunctionsExtendedMaxDuration, cpu } = row;
  return cpu;
}

module.exports = { workerCpu };
