// Feature-flag mirror for the Vercel project API. The aliased binding is
// still referenced below, so the mend must leave this file byte-identical
// even though the pattern is anchored to resourceConfig - reference
// counting, not the anchor gate, is the defense here.
function mirrorFlags(project) {
  const { enableFunctionsExtendedMaxDuration: ext, functionDefaultMemoryType } = project.resourceConfig;
  return { extended: ext === true, memory: functionDefaultMemoryType };
}

module.exports = { mirrorFlags };
