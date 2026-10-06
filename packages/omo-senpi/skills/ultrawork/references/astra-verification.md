8. Reuse actual execution evidence when it covers the requirement at the
   relevant code state. Record the commit plus relevant working-tree
   changes, exact command or scenario, environment and dependencies,
   captured result, and what the artifact exercised. A child's prose
   claim alone is insufficient; inspect its execution capture and state.
   After each increment rerun checks whose inputs moved. Before the final
   message, assess coverage of the required scenarios, suite, typecheck,
   build, and repository-mandated checks using those captures. Run any
   missing, stale, contradictory, or uncovered check, and integration
   verification invalidated by combined changes. Resolve real failures.
   Cite still-valid PASS evidence for the rest; do not repeat an already
   passing check solely because work is ending. Record PASS/FAIL beside
   each artifact. Loop until all requirements have valid PASS evidence.
