---
name: module-system-reimplementation-divergences
description: When reimplementing or mounting types inside the nixpkgs module system (evalModules) and parity breaks
type: practice
---

**Rule:** When a reimplemented module system is consumed by the real `lib.evalModules`, each behavioural divergence fails separately as evaluation advances. Root-cause each one at source, and pin it with a byte-identical `drvPath` comparison.

**Why:** Four gen-merge/gen-schema divergences, each found by mounting pure gen-schema types inside a real consumer. A fifth will rhyme with one of them:

1. **`substSubModules` must REPLACE, not concatenate.** nixpkgs passes `opt.options`, which already contains the type's relocated base module. Concatenating evaluated the base twice, so a `readOnly` field was "defined 2 times".
2. **Never descend into override content while discharging priorities.** Doing so force-evaluated every `mkOverride`-wrapped definition, including the losing default, before the filter dropped it. Stamp the priority and keep the content lazy.
3. **`config._module.args` needs two views.** It is readable inside modules, but `_module` is stripped from the returned `config`. Re-injecting it into the returned config breaks whole-config equality and drags in self-referential contents.
4. **Identity reflection must recognise the reference library's type names** (`str`, not only `string`). Otherwise identity fields are dropped silently and two entities collapse to one hash, with no error, just a wrong edge count.

Also measured: overriding `final.modules` alone in a lib extension propagates the whole module surface, including submodule-base re-entries, which is ownership a naive identity extension cannot reach. Prove it with a marker test. Byte identity is meaningful only when the vendored body, the template's nixpkgs and the pin all agree.

**How to apply:** Mount against a real consumer early, and compare the `drvPath` before and after each fix. Keep regression tests per divergence.

Related: \[[oracle-design]\] \[[parity-with-a-reference]\]
