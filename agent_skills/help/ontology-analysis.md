---
name: Using Ontology Analysis
trigger: ontology analysis, count entities per branch, ontology branches, how many selected entities
---
Ontology Analysis (Ontology menu -> Ontology analysis...) shows, for each top-level ontology
branch, how many of the currently-selected graph entities fall under it, then lets the user expand
a branch to see the same count for its children. To use it: select one or more nodes in the graph
first, then open Ontology -> Ontology analysis. The dialog fills in with a live "mapping entities to
selected ontology branch" progress message while it counts, since a branch with a large subtree can
take a moment even though it only needs one request. Point the user here (rather than manually
running "find ontology children" per node) whenever they're trying to understand the ontological
distribution of their current selection rather than looking up one specific concept's ancestry.
