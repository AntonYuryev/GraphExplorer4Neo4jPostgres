---
name: Validating Effect sign against evidence text
trigger: effect, validate effect, positive or negative, is this effect correct, mechanism, activates, inhibits
---
When asked to validate or infer the Effect property (positive/negative/unknown) of a relation
against its supporting sentences:

- Look for explicit directional language in the sentence text (activates, induces, upregulates,
  promotes -> positive; inhibits, suppresses, downregulates, blocks -> negative).
- A sentence that only reports an association/correlation without directional language does NOT
  support either a positive or negative Effect — say so rather than guessing from context.
- If the sentences disagree on direction, do not average or silently pick one — report the split
  explicitly (see the Summarize agent's "conflicting evidence" skill for phrasing this).
- When you can state a more precise Effect than the relation's current value (e.g. current value is
  "unknown" but every sentence clearly supports "negative"), propose the specific change and cite
  which sentence(s) support it — never change a property without being able to point to the text
  that justifies it.
