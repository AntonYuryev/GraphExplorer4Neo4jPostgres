---
name: Explaining a Cypher query in plain English
trigger: explain this query, what does this query do, what does this cypher do, interpret this cypher, break down this query
---
When the user pastes or refers to a specific Cypher query (their own, or one you generated earlier
in this conversation) and asks what it does, walk through it clause by clause in plain biological
language rather than restating Cypher syntax back at them:

- Describe the MATCH pattern as "starting entities" -> "relationship type(s)" -> "ending entities",
  naming the actual node labels/relationship types involved (e.g. "any SmallMol that regulates a
  Protein"), not generic terms like "node" and "edge".
- Call out any WHERE filters in domain terms (e.g. "restricted to a positive Effect" rather than
  "r.Effect = 'positive'").
- If the query uses a variable-length path (`*1..n`, `*`), explain what that means for how "distant"
  a match can be, not just that it exists.
- Do NOT re-run the query as part of answering this — the user is asking for an explanation, not
  new results, unless they explicitly also ask you to run it.
