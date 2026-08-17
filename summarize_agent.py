import re
import contextvars
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple, Annotated, DefaultDict
from collections import defaultdict

from pydantic import BaseModel, ConfigDict, Field
from ResnetGraph.ElsevierAPI.api.ResnetAPI.ResnetGraph import ResnetGraph, PSObject, PSRelation, Reference, PUBYEAR, CLOSENESS
from ResnetGraph.ElsevierAPI.api.ResnetAPI.NetworkxObjects import MECHANISM,OBJECT_TYPE, EFFECT, RELATIONID, EFFECT, TITLE, SENTENCE, JOURNAL
from ResnetGraph.ElsevierAPI.api.EmbioPSG_API.PSnx2Neo4j import neo4j_nx, ANATOMICAL_CONCEPTS_NEO4J
from ResnetGraph.ElsevierAPI.api.ResnetAPI.PSPathway import PSPathway
from ResnetGraph.ElsevierAPI.utils.utils import tokenize, unpack,ThreadPoolExecutor 

RELATION_NAME = 'Relation symbolic name'

_RUNTIME: Dict[str, Any] = {} # runtime dependencies are injected at startup
_REL_TOKEN_RE = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*$')
_NLP_MARKUP_RE = re.compile(r'ID\{[^{}=]+=(.*?)\}')
# CONTEXT{8803117}-style markup carries no user-facing text (unlike ID{...=text}) —
# strip it out entirely, including the number inside the braces, along with any
# leading whitespace so it doesn't leave a dangling space behind.
_CONTEXT_MARKUP_RE = re.compile(r'\s*CONTEXT\{[^{}]*\}')

# Standard English stop words to keep out of context_dict — without this, a node
# whose name/alias happens to be a single common word (e.g. a gene symbol that
# collides with an English word) would make every occurrence of that word in the
# user's message match the node, flooding the summary context with irrelevant hits.
_STOP_WORDS = frozenset({
    "a", "about", "after", "all", "an", "and", "any", "are", "as", "at",
    "be", "because", "been", "before", "being", "between", "both", "but", "by",
    "can", "could", "did", "do", "does", "doing", "down", "during",
    "each", "few", "for", "from", "further",
    "had", "has", "have", "having", "he", "her", "here", "hers", "herself",
    "him", "himself", "his", "how",
    "i", "if", "in", "into", "is", "it", "its", "itself",
    "just",
    "me", "more", "most", "my", "myself",
    "no", "nor", "not", "now",
    "of", "off", "on", "once", "only", "or", "other", "our", "ours", "ourselves",
    "out", "over", "own",
    "same", "she", "should", "so", "some", "such",
    "than", "that", "the", "their", "theirs", "them", "themselves", "then",
    "there", "these", "they", "this", "those", "through", "to", "too",
    "under", "until", "up",
    "very",
    "was", "we", "were", "what", "when", "where", "which", "while", "who",
    "whom", "why", "will", "with", "would",
    "you", "your", "yours", "yourself", "yourselves",
})

def _runtime_(name: str):
    value = _RUNTIME.get(name)
    if value is None:
        raise RuntimeError(f"Summarize runtime dependency '{name}' is not configured")
    return value


def _strip_nlp_markup(text: Any) -> str:
    """Convert NLP markup like ID{4444444,66666=text} into plain text, and
    remove CONTEXT{...} markup (e.g. CONTEXT{8803117}) entirely, braces and all."""
    value = str(text or "")
    if "CONTEXT{" in value:
        value = _CONTEXT_MARKUP_RE.sub("", value)
    if "ID{" not in value:
        return value
    return _NLP_MARKUP_RE.sub(lambda m: m.group(1).strip(), value)


def prop_to_title(prop: Any) -> str:
    """Convert a property name in any common casing style to title case."""
    value = re.sub(r"[_-]+", " ", str(prop or "").strip())
    value = re.sub(r"(?<=[A-Z])(?=[A-Z][a-z])", " ", value)
    value = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", value)
    return value.title()


class ChatMessage(BaseModel):
    role: str
    content: str
    cypher: Optional[str] = None


class SummarizeRequest(BaseModel):
    llm: Optional[Dict[str, Any]] = None
    model_config = ConfigDict(arbitrary_types_allowed=True)
    neo4j : Optional[neo4j_nx] = None #api to Neo4j database, initialized at app startup
    db_credentials: Optional[Dict[str, Any]] = None  # Database connection credentials from the app
    neo4j_node_types: List[str] = []       # Neo4j node labels loaded into memory at app startup
    neo4j_relation_types: List[str] = []   # Neo4j relationship types loaded into memory at app startup
    
    scope: Optional[str] = None # "selected" or "all" edges in the graph to summarize
    message: str
    history: List[ChatMessage] = []
    
    CurrentNodeJSGraph: Optional[Dict[str, Any]] = None # input graph from the app, including nodes, edges, and selected nodes/edges
    _ResnetGraph_: Optional[PSPathway] = None
    
    default_context: List[PSObject] = []
    default_anatomy: List[PSObject] = []
    context_dict: Annotated[DefaultDict[str, List[PSObject]], Field(default_factory=lambda: defaultdict(list))]  # local vocab to lookup nodes by tokenized name/aliases from user messages

 
    @staticmethod
    def relationIDs4edge(edge: Dict[str, Any]) -> List[int]:
        """Extract relation IDs from a single edge dict."""
        if not isinstance(edge, dict):
            return []
        rid = edge.get("relationId")
        rids = set(rid) if isinstance(rid, list) else {rid}
        if edge.get("relationIds") and isinstance(edge.get("relationIds"), list):
            rids.update(edge.get("relationIds"))
        return [int(str(r).strip()) for r in rids if r is not None and str(r).strip().isdigit()]


    def edges4(self, node_urns: List[str]) -> List[Dict[str, Any]]:
        """Return CurrentNodeJSGraph edges where either endpoint's URN is among node_urns.

        Used by relationIDs() to pull in edges connecting selected NODES even
        when the user selected only the nodes on canvas (not the edge between
        them) — e.g. box-selecting a cluster of nodes without touching an edge.
        """
        if not node_urns:
            return []
        urns = set(node_urns)
        cg = self.CurrentNodeJSGraph if isinstance(self.CurrentNodeJSGraph, dict) else {}
        all_edges = cg.get("edges") or []
        return [
            e for e in all_edges
            if isinstance(e, dict) and (e.get("sourceURN") in urns or e.get("targetURN") in urns)
        ]


    @staticmethod
    def edge2psrel(edge: Dict[str, Any]) -> Optional[PSRelation]:
        regulator_name = str(edge.get("source") or "").strip()
        regulator_urn = str(edge.get("sourceURN") or {})
        regulator_type = str(edge.get("sourceType") or "").strip()
        regulatorNodeid = str(edge.get("sourceNodeId") or "").strip()
        regulator = PSObject({'URN': [regulator_urn], 'Name': [regulator_name], OBJECT_TYPE: [regulator_type],'Neo4jID':[regulatorNodeid]})

        target_name = str(edge.get("target") or "").strip()
        target_urn = str(edge.get("targetURN") or {})
        target_type = str(edge.get("targetType") or "").strip()
        targetNodeid = str(edge.get("targetNodeId") or "").strip()
        target = PSObject({'URN': [target_urn], 'Name': [target_name], OBJECT_TYPE: [target_type],'Neo4jID':[targetNodeid]})

        rel_type = str(edge.get("type") or "").strip()
        rel_effect = str(edge.get("effect") or "").strip()
        rel_mechanism = str(edge.get("mechanism") or "").strip()
        rel_props = {OBJECT_TYPE: [rel_type], 
                        EFFECT: [rel_effect],
                        }
        rel_props[RELATIONID] = SummarizeRequest.relationIDs4edge(edge)
        if rel_mechanism:
            rel_props[MECHANISM] = [rel_mechanism]

        ps_refs = []
        edge_refs = edge.get("references") if isinstance(edge.get("references"), list) else []      
        for ref in edge_refs:
            if not isinstance(ref, dict):
                continue
            pmid = str(ref.get("pmid") or "").strip()
            doi = str(ref.get("doi") or "").strip()
            title = str(ref.get("title") or "").strip()
            pubyear = str(ref.get("pubyear") or "").strip()
            #authors = str(ref.get("authors") or "").strip()
            journal = str(ref.get("journal") or "").strip()
            sentence = str(ref.get("msrc") or "").strip()
            if not sentence:
                sentence = str(ref.get("sentence") or "").strip()
            if pmid:
                psref = Reference('PMID', pmid)
                if doi:
                    psref.Identifiers['DOI'] = doi
            elif doi:
                psref = Reference('DOI', doi)
            else:
                continue
            if title:
                psref[TITLE] = [title]
            if pubyear:
                psref[PUBYEAR] = [pubyear]
            if journal:
                psref[JOURNAL] = [journal]

            if sentence:
                textref = psref.add_snippet('', {SENTENCE: {sentence}})
                stripped_sentence = _strip_nlp_markup(sentence)
                psref.add_sentence_prop(textref, 'sentence_nomarkup', stripped_sentence)
                tokenized_sent =  tokenize(stripped_sentence)
                merged_tokens = ' '.join(tokenized_sent)
                psref.add_sentence_prop(textref, 'tokenized_sentence', merged_tokens)
            ps_refs.append(psref)

        return PSRelation.make_rel(regulator, target,rel_props,ps_refs)


    @staticmethod
    def edges2psrels(edges: List[Dict[str, Any]]) -> List[PSRelation]:
        ps_rels = []
        for edge in edges:
            if not isinstance(edge, dict):
                continue
            ps_rel = SummarizeRequest.edge2psrel(edge)
            if ps_rel:
                ps_rels.append(ps_rel)
        return ps_rels


    def init_resnet_graph(self) -> ResnetGraph:
        if self._ResnetGraph_:
            return self._ResnetGraph_

        self.neo4j = neo4j_nx(self.db_credentials or {})
        cg = self.CurrentNodeJSGraph if isinstance(self.CurrentNodeJSGraph, dict) else {}

        # !!!App sends aliases as list already!!!
        urn2aliases = {
            n.get("urn"): n.get("aliases")
            for n in (cg.get("nodes") or [])
            if isinstance(n, dict)
        }

        ps_rels = []
        for edge in (cg.get("edges") or []):
            if not isinstance(edge, dict):
                continue
            ps_rel = SummarizeRequest.edge2psrel(edge)
            ps_rels.append(ps_rel)

        resnet_graph = ResnetGraph.from_rels(ps_rels)
        resnet_graph.set_node_annotation(urn2aliases, "Alias")
        resnet_graph.annotate_closeness()
        
        pathway_names = self.get_graph_names()
        pathway_name = ','.join(pathway_names)
        pathway_props = {'Name': [pathway_name]}
        for prop, val in cg.items():
            if prop not in {'nodes', 'edges', 'selectedNodes', 'selectedEdges', 'graphName', 'pathwayName','tabName','subgraphName', 'currentSubgraphName','name','title'}:
                pathway_props[prop_to_title(prop)] = [val]
        self._ResnetGraph_ = PSPathway(pathway_props, resnet_graph)
        return self._ResnetGraph_
        
    
    def graph2analyze(self) -> PSPathway:
      '''
      Converts CurrentNodeJSGraph to PSPathway object for summarization.
      If self.scope is "selected", only selected edges and nodes are included.
      '''
      cg = self.CurrentNodeJSGraph or {}

      my_edges = []
      if self.scope == "selected":
          edges = (cg.get("selectedEdges") or [])
          selected_nodes_urns = [n.get("urn") for n in (cg.get("selectedNodes") or []) if isinstance(n, dict) and n.get("urn")]
          my_edges = edges + (self.edges4(selected_nodes_urns) if selected_nodes_urns else [])
      else:
          my_edges = cg.get("edges") or []
      
      my_rels = SummarizeRequest.edges2psrels(my_edges)
      graph2analyze = ResnetGraph.from_rels(my_rels)
      pathway_names = self.get_graph_names()
      pathway_name = ','.join(pathway_names)
      pathway_props = {'Name': [pathway_name]}
      for prop, val in cg.items():
          if prop not in {'nodes', 'edges', 'selectedNodes', 'selectedEdges', 'graphName', 'pathwayName','tabName','subgraphName', 'currentSubgraphName','name','title'}:
              pathway_props[prop_to_title(prop)] = [val]
      my_pathway = PSPathway(pathway_props, graph2analyze)
      return my_pathway
        


    def get_graph_names(self) -> List[str]:
        cg = self.CurrentNodeJSGraph or {}
        vals = set()
        for k in ["graphName", "tabName", "pathwayName", "subgraphName", 
                  "currentSubgraphName", "name", "title"]:
            v = cg.get(k)
            if isinstance(v, str) and v.strip():
                vals.add(v.strip())
        return list(vals)


    def graph_nodes(self) -> List[PSObject]:
      '''
        Returns a list of PSObject nodes in the graph, filtered by self.neo4j_node_types if specified.
      '''
      if self._ResnetGraph_:
        return [n for n in self._ResnetGraph_.nodes() if n.objtype() in self.neo4j_node_types] if self.neo4j_node_types else self._ResnetGraph_.nodes()
      return []



    def _default_context_(self) -> tuple[List[str], List[str]]:
        if self.default_anatomy or self.default_context: 
            return list(self.default_anatomy), list(self.default_context)
        
        anatomy_nodes = set() # {PSObject} of anatomical concepts in the graph
        other_context = set() # {PSObject} of other context concepts in the graph (CellProcess, Disease, ClinicalParameter, Treatment)

        central_nodes_counter = 0 # {PSObject} of the two most central nodes in the graph, by closeness and degree
        graph_nodes = self.graph_nodes()
        graph_nodes = sorted(graph_nodes, key=lambda n: (self._ResnetGraph_.graph.degree(n.uid()), n[CLOSENESS]), reverse=True) if graph_nodes else []
        for node in graph_nodes:
          node_type = node.objtype()
          if node_type in ANATOMICAL_CONCEPTS_NEO4J:
              anatomy_nodes.add(node)
          elif node_type in ['CellProcess','Disease','ClinicalParameter','Treatment']:
              other_context.add(node)
          elif central_nodes_counter < 2:
              other_context.add(node)
              central_nodes_counter += 1

        # obtaining additional anatomy terms from other context, e.g. "lung cancer" -> "lung"
        other_context_tokens = set(unpack([tokenize(n) for n in self.get_graph_names()]))
        for concept in other_context:
          concept_names = {str(concept.name())}
          concept_names.update(concept['Alias'])
          for name in concept_names:
            tokens = tokenize(name)
            other_context_tokens.update(tokens)

        # collecting anatomical annotations from curated pathways
        for prop, vals in self._ResnetGraph_.items():
          if prop in ANATOMICAL_CONCEPTS_NEO4J or prop == 'Organ System':
            print('Adding annotations from curated pathway:', prop, vals)
            other_context_tokens.update(vals)
            other_context_tokens.update(unpack([tokenize(v) for v in vals]))

        anatomy_nouns = {to_root_noun(t) for t in other_context_tokens}
        other_context_tokens.update(anatomy_nouns)

        anatomy_names = [str(a.name()) for a in anatomy_nodes]
        [anatomy_names.extend(n['Alias']) for n in anatomy_nodes if 'Alias' in n]
        anatomy_names = {n.lower() for n in anatomy_names}
        
        new_tokens = other_context_tokens - anatomy_names # all tokens from other context that are not already in the graph's anatomy nodes
        try:
            new_anatomy = self.neo4j.find_nodes_by_names(list(new_tokens), objtypes=list(ANATOMICAL_CONCEPTS_NEO4J), with_connectivity=False) if self.neo4j else []
            expanded_anatomy = set(anatomy_nodes) | set(new_anatomy)
            if self.neo4j:
                self.neo4j._load_children_(expanded_anatomy)
                self.neo4j._load_children_(other_context)
        except Exception as _neo4j_err:
            print(f'[summarize_agent] Neo4j unavailable during _default_context_ — continuing without expanded anatomy/context: {_neo4j_err}')
            new_anatomy = []

        self.default_anatomy = list(set(anatomy_nodes) | set(new_anatomy))
        self.default_context = list(other_context)

        for node in graph_nodes:
            node_name = str(node.name() or "")
            if node_name:
                tokenized_name = tokenize(node_name)
                tokenized_name_str = " ".join(tokenized_name)
                if tokenized_name_str and tokenized_name_str not in _STOP_WORDS:
                    self.context_dict[tokenized_name_str].append(node)
            for alias in node['Alias']:
                if alias:
                    tokenized_aliases = tokenize(alias)
                    if len(tokenized_aliases) >=2:
                        tokenized_alias_str = " ".join(tokenized_aliases)
                        if not tokenized_alias_str.isnumeric() and tokenized_alias_str not in _STOP_WORDS:
                            self.context_dict[tokenized_alias_str].append(node)
        
        return self.default_anatomy, self.default_context


    def select_refs(self, in_graph:PSPathway, _4focus_nodes: Optional[List[PSObject]], max_lines:int=300) -> List[PSRelation]:
      """
      input:
        - in_graph: PSPathway object representing the graph to analyze for summarization
        - _4focus_nodes: list of PSObjects to filter sentences by
      output:
        [PSRelation] containing only references to feed into the LLM for summarization.
      """
      graph_nodes = set(self.graph_nodes())
      focus_nodes_in_graph = []
      focus_nodes_notin_graph = []
      [(focus_nodes_notin_graph,focus_nodes_in_graph)[node in graph_nodes].append(node) for node in _4focus_nodes]

      # adding all edges for focus nodes in in_graph
      selected_rels = in_graph.graph.get_neighbors_rels(focus_nodes_in_graph)
      
      # now adding refs for focus nodes that are not in in_graph
      search_node_terms = set()
      for node in focus_nodes_notin_graph:
        search_node_terms.add(str(node.name()).lower())
        search_node_terms.update(map(str.lower, node['Alias']))

      for rel in in_graph.rels():
        matched_refs = []
        for ref in rel.refs():
          for textref, snippet in ref.snippets.items():
            for tokenized_sentence in snippet.get('tokenized_sentence', set()):
              sentence_tokens = set(tokenized_sentence.split(' '))
              if not sentence_tokens.isdisjoint(search_node_terms):
                matched_refs.append(ref)
                break

        if matched_refs:
          new_rel = rel.copy()
          new_rel.references = matched_refs
          selected_rels.add(new_rel)

      max_ref_index = max_lines//len(selected_rels) +1
      for rel in selected_rels:
        refs = rel.refs()
        refs.sort(key=lambda r: r.pubyear(), reverse=True)
        rel.references = refs[:max_ref_index]
      return selected_rels


    @staticmethod
    def make_sentences4prompt(selected_rels: list[PSRelation]) -> str:
      '''
      input:
        - selected_rels: list of PSRelation objects, each containing references selected for summarization
      output:
      - Relation Name:(PMID 12345678, 2020, Title, Journal of Biology [anatomical context]) "Title of the paper": "This is a supporting sentence from the literature."
      Not for UI display, this is for LLM prompt context only. The LLM will use these sentences to generate a summary, but the output will not include these sentences verbatim.
      max_lines caps the total number of sentence lines to keep the prompt fast.
      '''
      lines: list[str] = []
      seen_sentences: set = set() # deduplicate identical sentence text
      for rel in selected_rels:
        for ref in rel.refs():
          bibliography = [ref.identifiers_str()]
          pubyear = ref.pubyear()
          if pubyear > 1812:
            bibliography.append(str(pubyear))
          journal = ref.journal()
          if journal != 'No journal name':
            bibliography.append(journal)

          for textref, snippet in ref.snippets.items():
            anatomical_context = []
            for prop, provalues in snippet.items():
              if prop in ANATOMICAL_CONCEPTS_NEO4J:
                anatomical_context.extend(provalues)

            for sentence_nomarkup in snippet.get('sentence_nomarkup', []):
              norm = sentence_nomarkup.strip().lower()
              if norm in seen_sentences:
                  continue
                
              seen_sentences.add(norm)
              if anatomical_context:
                anatomical_context = sorted(set(anatomical_context))
                line = f'({", ".join(bibliography)} [{"; ".join(anatomical_context)}]) "{ref.title()}": "{sentence_nomarkup}"'
              else:
                line = f'({", ".join(bibliography)}) "{ref.title()}": "{sentence_nomarkup}"'
              lines.append(rel.name()+':' + line)

      return "\n".join(lines), len(lines)


    def parse_message(self):
      '''
      Tokenizes user message and finds context nodes in the graph that match the tokenized message. 
        Returns:
        use_default_context: bool, whether to use default context nodes or not
        list of context nodes:  Falls back to self.default_context + self.default_anatomy if no context nodes are found in user message.
        focus mode: "methods", "procedures", or None
        recent year range: tuple of (min_year, max_year) if a year range is found in the message, else None
      '''
      tokenized_message = tokenize(str(self.message or ""))
      context_nodes = []
      for i in range(len(tokenized_message)-3):
          onegram = tokenized_message[i:i+1][0]
          context_nodes = self.context_dict.get(onegram, [])
          if context_nodes: 
              break
          else:
              twogram = " ".join(tokenized_message[i:i+2])
              context_nodes = self.context_dict.get(twogram, [])
          if context_nodes: 
              break
          else:
              threegram = " ".join(tokenized_message[i:i+3])
              context_nodes = self.context_dict.get(threegram, [])
              if context_nodes: 
                  break

      # last resort to get context nodes from the last two or one token(s) of the message 
      # if no context nodes were found in the previous loop
      if not context_nodes:
          context_nodes = self.context_dict.get(" ".join(tokenized_message[-2:]), [])
          if not context_nodes:
              context_nodes = self.context_dict.get(" ".join(tokenized_message[-1:]), [])

  # finding and including ontology children for context nodes
      if context_nodes:
          nodes_need_children = []
          for node in context_nodes:
              if not node.childs():
                  nodes_need_children.append(node)
          self.neo4j._load_children_(nodes_need_children) if self.neo4j else None

          context_nodes_set = set(context_nodes)
          [context_nodes_set.update(node.childs()) for node in context_nodes.copy()]
          use_default_context = False
      else:
          context_nodes_set = set(self.default_context + self.default_anatomy)
          use_default_context = True

      return use_default_context, list(context_nodes_set), _focusON_(self.message), _recent_year_range_(self.message), _uses_general_knowledge_(self.message)


    @staticmethod
    def prompt_introduction(graph2analyze: PSPathway, use_general_knowledge: bool = False) -> str:
      introduction = "## Summary Task Rules\n"
      if 'Description' in graph2analyze:
          introduction += f"\n## This pathway has description\n{graph2analyze.graph}.  Use it in your introduction and summary if relevant.\n"
      if 'Notes' in graph2analyze:
          introduction += f"\n## This pathway has manually curated notes\n{graph2analyze.graph}. Use it in your introduction and summary if relevant.\n"

      introduction += "Each sentence in Supporting Sentences starts with a symbolic relation name indicating what kind of interaction it describes. "
      introduction += "Write in flowing prose — do not list or enumerate relation type names. "
      introduction += "Combine related interactions into single sentences where possible. "
      introduction += "Example: protein A, activated by kinase K, forms a complex with protein B to drive downstream targets Target1 and Target2.\n"
      introduction += "Use conjunctions and transition words to connect ideas naturally."

      if use_general_knowledge:
        introduction += f"""
      - Primary source: Supporting Sentences below are your first source of truth.
        Each sentence has a PMID or DOI citation; include those citations whenever you draw from them.
      - General knowledge: the user has explicitly asked you to supplement the Supporting Sentences
        with your pre-trained biomedical knowledge. You MAY draw on background knowledge, but you MUST
        clearly distinguish evidence-based claims from general-knowledge claims, for example:
          * Evidence-based: "PINK1 phosphorylates HTRA2 (PMID 18174901)."
          * General knowledge: "General knowledge: intermediate kinases such as MKK3/MKK6 are known
            upstream activators of p38 in stress-response contexts, though this link is not in the pathway evidence."
      - Focus on statements repeated across multiple Supporting Sentences, and prioritize those over single-sentence claims.
      - Non-repetition: every biological interaction must be mentioned exactly once.
        Never describe the same pair of entities or the same directional relationship in more than one section.
      - Omission: if neither Supporting Sentences nor your general knowledge has anything applicable, say so.
      - Length cap: no more than {graph2analyze.number_of_edges()} sentences per section. Be succinct.
      - Long list truncation: name only the first 3 items then say "... and N more".
      - Citation rule: at the end of each evidence-based sentence list ALL PMIDs as a compact citation
        "PMID 12345678, PMID 23456789,". Do NOT use markdown URLs.
        General-knowledge sentences carry no PMID but must be labelled "General knowledge:".
      """
      else:
        introduction += f"""
      - Supporting Sentences below are the ONLY information you may use to write your summary.
        Each sentence has a PMID or DOI citation, and you must include those citations in your summary.
        Do not add any information that is not in the Supporting Sentences.
      - Focus on statements repeated across multiple Supporting Sentences, and prioritize those over single-sentence claims.
      - Non-repetition: every biological interaction must be mentioned exactly once.
        Never describe the same pair of entities or the same directional relationship in more than one section, even in different words.
      - Omission and no information: if Supporting Sentences have nothing applicable reply "No information available".
      - Length cap: no more than {graph2analyze.number_of_edges()} sentences per section. Be as succinct as possible. Try mentioning multiple relations in one sentence.
      - Long list truncation: if a section would otherwise list many concepts, name only the first 3 and
        then say "... and N more" (or similar) rather than listing everything.
      - Citation rule: at the end of each sentence that has supporting evidence, list ALL PMIDs that
        support it as a single compact citation using the exact form "PMID 12345678, PMID 23456789, PMID 34567890,".
        The app automatically renders this as a single clickable "Pubmed references" link — do NOT write individual per-PMID links or
        markdown URLs. Prefer PMID citations over DOI or journal/year when both are available.
      """

      if not use_general_knowledge:
        introduction += """IMPORTANT: Strict grounding !!! — read this before writing anything
          You are NOT permitted to use general pre-trained/background biomedical knowledge to fill in,
          embellish, or "complete" this summary. Every claim must trace back to one of the sentences listed
          in "Supporting Sentences" below. If something isn't in those sentences, it does not go in your
          answer, full stop — not even something you're confident is true from training.
          """

      return introduction


    @staticmethod
    def focus_nodes_section(context_nodes:list[PSObject])->str:
      if context_nodes:
        context_name_list = sorted([str(node.name()) for node in context_nodes])
        context_names = ', '.join(context_name_list)
        focus_note = f"## Summarization focus\nFocus summarization on the following concepts: {context_names}\n"
        return focus_note
      return ''

    
    @staticmethod
    def focus_section(focus_mode:str,graph2analyze:PSPathway, context_nodes:list[PSObject])->str:
      if not focus_mode:
        return ''  
      if focus_mode == "methods":
        return """
      User explicitly asks about experimental methods. Title your summary "Experimental Methods" and describe only experimental methods explicitly named in the supporting sentences.
      Prioritize assay names, measurement platforms, techniques, protocols, platforms, sample preparation, controls, and statistical methods only when they are written in the evidence.
      If the evidence does not mention methods, say that the supporting sentences do not list experimental methods.
    - do not infer missing method details from background knowledge.
    - be complete about the named methods, but still stay grounded in the supporting sentences and avoid broadening beyond what is written.
      \n
      """
      elif focus_mode == "procedures":
        return """
      User explicitly asks about medical procedures. Title your summary "Medical Procedures" and
      describe only medical procedures and clinical processes explicitly named in the supporting sentences.
      Prioritize operations, interventions, clinical measurements, and procedure-related outcomes only when they are written in the evidence.
      If the evidence does not mention procedures, say that the supporting sentences do not list medical procedures.
    - do not infer missing procedure details from background knowledge.
    - be complete about the named procedures, but still stay grounded in the supporting sentences and avoid broadening beyond what is written.
      \n
      """
      elif focus_mode == "introduction":
        context_names = ', '.join(sorted([str(node.name()) for node in context_nodes]))
        return f"""Title your summary "Introduction".
HARD LIMIT: write EXACTLY 3-5 sentences — no more. This overrides every other length rule.
Do NOT list or describe individual interactions, relations, or evidence sentences.
Write a high-level paragraph explaining why the {graph2analyze.name()} pathway was built and in what biological, anatomical, or clinical context it is important.
Make sure to mention {graph2analyze.name()} and {context_names}."""

      elif focus_mode == "molecular_cell":
        return """Title your summary "Molecular and Cellular Interactions" and describe only molecular and cellular interactions explicitly named in the supporting sentences.
          You must summarize molecular interactions: proteins, small molecules, cell organelles, and cellular-level processes.
          Use your own biological judgement to keep this to genuinely INTRACELLULAR-level events, not broader
          physiological/systemic entities (Disease, ClinicalParameter, whole-organ or whole-organism
          processes) even if they're mentioned in the same sentence — those belong in Physiology/Organ System
          below instead.
          """
      elif focus_mode == "physiology":
        return """Title your summary "Physiology" and describe only physiological interactions explicitly named in the supporting sentences.
          You must summarize physiological interactions: organ-level processes, tissue-level processes, and organismal-level processes.
          Use your own biological judgement to keep this to genuinely PHYSIOLOGICAL-level events, not low level
          molecular events (proteins, small molecules, cell organelles, and cellular-level processes) even if they're mentioned in the same sentence.
          You are allowed to describe interactions between anatomical concepts (cell types, tissues, organs); 
          You can mention only molecular signaling that mediates intercellular communication (hormones/ligands, secreted proteins, membrane receptors) if they are explicitly mentioned in the supporting sentences as part of a physiological process.
          Do not include intracellular signaling, gene regulation, or molecular-level events that are not directly part of the physiological process.
          Do not include systemic-level processes that are not directly part of the physiological process.
          Focus on physiological processes and localized effector mechanisms (e.g. vasoconstriction, nerve outgrowth).
            """
      elif focus_mode == "organ_system":
        return """Title your summary "Organ System" and describe only organ system-level interactions explicitly named in the supporting sentences.
          You must summarize organ system-level interactions: integrated body function, whole-body responses, and organismal states.
          Use your own biological judgement to keep this to genuinely ORGAN SYSTEM-level events, not low level. 
          Systemic phenotypes, organismal states, and macroscopic biological processes affecting integrated
          body function — whole-body responses like pregnancy, memory, learning, endurance.
          Do not include intracellular signaling, gene regulation, or molecular-level events that are not directly part of the organ system process.
          Do not include physiological-level processes that are not directly part of the organ system process.
          Example of organ system-level processes: cardiovascular system, nervous system, endocrine system, immune system, reproductive system, digestive system, respiratory system, musculoskeletal system.
          """
      elif focus_mode == "follow-up":
        return"""
          ## This is user follow-up question.
          - If the answer is present in the Supporting Sentences below, answer it directly, citing which
          sentence(s) it comes from.
          - If the answer is NOT present, say so explicitly ("the supporting sentences don't address that").  Then answer from from general knowledge or guessing.
          """
  
      return ""


    def _system_prompts_(self,is_followup=False) -> tuple[str, list[str], int]:
      '''
      Generates system prompts, including context, focus, and structure rules to be used in parallel for the LLM summarization task.
      output:
          intro_line, prompts, number of references used in the prompts
      '''
      prompts = []
      skills_section = _runtime_("skills_prompt_section")("summarize", "")
      
      graph2analyze = self.graph2analyze()
      if not graph2analyze or not graph2analyze.graph or graph2analyze.graph.number_of_edges() == 0:
          return "No edges were found in the graph to summarize. Please select edges or nodes in the graph and try again.", "", 0

      if self.scope == "selected":
        intro_line = f"Summary scope is {graph2analyze.number_of_edges()} relation(s) selected in {graph2analyze.name()} graph.\n"
      else:
        intro_line = f"Summary scope is entire {graph2analyze.name()} graph with {graph2analyze.number_of_edges()} relation(s).\n"

      use_default_context, context_nodes, focus_mode, pubyear_range, use_general_knowledge = self.parse_message()

      if pubyear_range:
        graph2analyze = graph2analyze.filter_rels_by_year(min_year=pubyear_range[0], max_year=pubyear_range[1])
        intro_line += f"Will filter supporting sentences to those published between {pubyear_range[0]} and {pubyear_range[1]}.\n"

      if use_default_context:
        intro_line += f"\nWill use {len(context_nodes)} default context concepts.\n"
      else:
        intro_line += f"\nWill use {len(context_nodes)} context concepts identified in your message.\n"

      rels4prompt = self.select_refs(in_graph=graph2analyze, _4focus_nodes=context_nodes)
      evidence, number_of_supporting_sentences = self.make_sentences4prompt(rels4prompt)

      prompt = self.prompt_introduction(graph2analyze, use_general_knowledge=use_general_knowledge)
      prompt += self.focus_nodes_section(context_nodes)
      if focus_mode:
        prompts.append(prompt+self.focus_section("follow-up", graph2analyze, context_nodes))
      else:
        if is_followup:
          prompts.append(self.focus_section("follow-up", graph2analyze, context_nodes))
        else:
          for mode in ["introduction", "molecular_cell", "physiology", "organ_system"]:
            prompts.append(prompt+self.focus_section(mode, graph2analyze, context_nodes))

      # Strings are immutable — `p += ...` in a for-loop rebinds the local var
      # and leaves the list unchanged.  Use a list comprehension instead.
      if use_general_knowledge:
        evidence_block = f"\n## Supporting Sentences (primary evidence — supplement with general knowledge when the user requests it):\n{evidence}\n"
      else:
        evidence_block = f"\n## Supporting Sentences (the ONLY information you may use):\n{evidence}\n"
      prompts = [p + evidence_block for p in prompts]

      return intro_line, prompts, number_of_supporting_sentences


def _strip_leading_overlap(existing: str, continuation: str, window: int = 1500) -> str:
    """Remove any prefix of `continuation` that duplicates text already in `existing`.

    When the LLM is asked to continue a truncated reply it sometimes restarts from
    the last section heading instead of the exact cut-off point.  This function
    compares non-empty lines from the start of `continuation` against the tail of
    `existing` and drops lines that are already present there.
    """
    if not existing or not continuation:
        return continuation
    tail = existing[-window:]
    cont_lines = continuation.split('\n')
    # Find the first line in the continuation that is genuinely new
    for i, line in enumerate(cont_lines):
        stripped = line.strip()
        if not stripped:
            continue  # skip blank lines when searching for the first new content
        if stripped not in tail:
            # Return from this line onward (preserve any leading blanks we skipped)
            return '\n'.join(cont_lines[i:])
    # Every non-blank line was already in the tail — return only the continuation
    # as-is so we never silently discard real new content.
    return continuation


def _recent_year_range_(message: str, default4recent = 2) -> Optional[Tuple[int, int]]:
    '''
    Returns a (start_year, end_year) tuple if the message contains a year range or recent-year request, otherwise returns None.
    '''
    msg = str(message or "").strip().lower()
    if not msg:
        return None

    now_year = datetime.now(timezone.utc).year
    min_year = 1900

    def _clamp_year(y: int) -> int:
        return max(min_year, min(now_year, int(y)))

    m = re.search(r"\bbetween\s+(\d{4})\s+and\s+(\d{4})\b", msg)
    if m:
        y1 = _clamp_year(int(m.group(1)))
        y2 = _clamp_year(int(m.group(2)))
        if y1 > y2:
            y1, y2 = y2, y1
        return (y1, y2)

    m = re.search(r"\bfrom\s+(\d{4})\s+to\s+(\d{4})\b", msg)
    if m:
        y1 = _clamp_year(int(m.group(1)))
        y2 = _clamp_year(int(m.group(2)))
        if y1 > y2:
            y1, y2 = y2, y1
        return (y1, y2)

    m = re.search(r"\b(since|from)\s+(\d{4})\b", msg)
    if m:
        y1 = _clamp_year(int(m.group(2)))
        return (y1, now_year)

    m = re.search(r"\bin\s+(\d{4})\b", msg)
    if m:
        y = _clamp_year(int(m.group(1)))
        return (y, y)

    if re.search(r"\b(last|past|previous)\s+year\b", msg):
        return (now_year - 1, now_year)

    m = re.search(r"\b(last|past|previous)\s+(\d{1,2})\s+years?\b", msg)
    if m:
        try:
            years = int(m.group(2))
            if years > 0:
                years = min(years, 50)
                return (now_year - years, now_year)
        except Exception:
            pass

    m = re.search(r"\b(\d{1,2})\s+years?\s+of\s+research\b", msg)
    if m:
        try:
            years = int(m.group(1))
            if years > 0:
                years = min(years, 50)
                return (now_year - years, now_year)
        except Exception:
            pass

    if re.search(r"\brecent\b", msg) and re.search(r"\b(findings?|research|found|publications?|pathway)\b", msg):
        return (now_year - default4recent, now_year)

    return None



def _call_summarize_llm(messages: List[Dict[str, str]], llm: Dict[str, Any], system_prompt: str, max_truncation_retries: int = 2):
    """Call the shared LLM helper, retrying if the provider truncates output.

    Summarize replies are plain prose, so a max-token cutoff can surface as a
    half-written section header or sentence. Unlike /chat, there is no tool loop
    here to naturally recover on the next turn, so retry immediately with a
    continue-from-here instruction, stripping any overlap the LLM writes anyway.
    """
    working_messages = list(messages)
    full_reply = ""
    was_truncated = False
    for attempt in range(max_truncation_retries + 1):
        reply_text, was_truncated = _runtime_("call_llm_with_retries")(working_messages, llm, system_prompt)
        if attempt > 0:
            # Strip any portion of reply_text that repeats text already in full_reply
            reply_text = _strip_leading_overlap(full_reply, reply_text)
        full_reply += reply_text
        if not was_truncated:
            return full_reply, False

        _runtime_("log").warning("Summarize reply truncated (attempt %d/%d)", attempt + 1, max_truncation_retries + 1)
        if attempt >= max_truncation_retries:
            break  # exhausted retries — return what we have

        # Ask the model to continue exactly from where it was cut off
        working_messages = working_messages + [
            {"role": "assistant", "content": reply_text},
            {"role": "user",      "content": "Your response was cut off. Please continue from exactly where you left off, without repeating anything already written."},
        ]
    return full_reply, was_truncated


def register_summarize_routes(app, runtime: Dict[str, Any]) -> None:
    _RUNTIME.clear()
    _RUNTIME.update(runtime)

    @app.post("/summarize-chat")
    def summarize_chat(req: SummarizeRequest):
        log = _runtime_("log")
        try:
            llm = _runtime_("effective_llm")(req.llm)
            is1st_turn = not req.history

            # Neo4j schema (node labels / relationship types) is loaded into memory
            # once at app startup (server.js pushes it to agent_service.py's /schema
            # endpoint) — populate it here from that shared runtime state rather
            # than requiring the frontend to resend it on every chat turn.
            req.neo4j_node_types = _runtime_("neo4j_node_types")()
            req.neo4j_relation_types = _runtime_("neo4j_relation_types")()

            req.init_resnet_graph()
            try:
                req._default_context_()
            except Exception as _ctx_err:
                print(f'[summarize_agent] _default_context_ failed — continuing without Neo4j context: {_ctx_err}')
            messages: List[Dict] = [{"role": m.role, "content": m.content} for m in req.history]
            messages.append({"role": "user", "content": req.message})

            intro_line, system_prompts, num_refs = req._system_prompts_(is_followup=not is1st_turn)

            # Guard: _system_prompts_ may return an error string instead of a list
            if not isinstance(system_prompts, list) or not system_prompts:
                return {"reply": intro_line, "llm_reference_count": 0, "was_truncated": False}

            futures = []
            reply_text = intro_line
            was_truncated = False
            # Each worker thread needs its OWN copy of the current context so that
            # _current_username (a ContextVar) is visible inside _call_llm's fallback
            # path.  A single copy cannot be entered by more than one thread at once,
            # so we call copy_context() once per prompt to get distinct objects.
            n_workers = max(1, len(system_prompts))
            with ThreadPoolExecutor(max_workers=n_workers) as executor:
                for prompt in system_prompts:
                    thread_ctx = contextvars.copy_context()
                    futures.append(executor.submit(thread_ctx.run, _call_summarize_llm, messages, llm, prompt))

                for future in futures:
                    try:
                        prompt_reply, prompt_reply_was_truncated = future.result()
                        if prompt_reply_was_truncated:
                            was_truncated = True
                        if prompt_reply and not prompt_reply.strip().startswith("No information available"):
                            reply_text += "\n\n" + prompt_reply
                    except Exception as section_exc:
                        log.error("Section LLM call failed: %s", section_exc, exc_info=True)
                        reply_text += "\n\n(Section could not be generated: " + str(section_exc) + ")"

            return {
                "reply": reply_text,
                "llm_reference_count": num_refs,
                "was_truncated": was_truncated
            }

        except Exception as exc:
            log.error("Unhandled error in /summarize-chat: %s", exc, exc_info=True)
            from fastapi import HTTPException
            raise HTTPException(status_code=500, detail=str(exc))


def to_root_noun(word:str):
    """
    helper function:\n
    Converts plurals and adjectives to their singular root nouns.
    Returns an empty string if the word was not modified.
    """
    _word = word.lower().strip()
    if not _word:
        return ""
        
    was_modified = False
    
    # STAGE 1: PLURAL TO SINGULAR
    plural_rules = [
        ("ices", "ix"),   # cervices -> cervix
        ("ges", "x"),     # phalanges -> phalanx
        ("ies", "y"),     # arteries -> artery
        ("ses", "sis"),   # diagnoses -> diagnosis
        ("ae", "a"),      # vertebrae -> vertebra
        ("ia", "ium"),    # atria -> atrium
        ("i", "us"),      # bronchi -> bronchus
        ("oes", "o"),     # potatoes -> potato
        ("ves", "f"),     # calves -> calf
        ("es", ""),       # reflexes -> reflex
        ("s", ""),        # cells -> cell
    ]
    
    for p_suffix, s_suffix in plural_rules:
        if _word.endswith(p_suffix) and len(_word) - len(p_suffix) >= 2:
            _word = _word[:-len(p_suffix)] + s_suffix
            was_modified = True
            break

    # STAGE 2: ADJECTIVE TO NOUN
    adj_rules = [
        ("neal", "neum"), # peritoneal -> peritoneum
        ("eal", "ea"),    # corneal -> cornea
        ("iac", "ium"),   # iliac -> ilium
        ("cular", "cle"), # ventricular -> ventricle
        ("ular", "ula"),  # scapular -> scapula
        ("ial", "ium"),   # cranial -> cranium
        ("cal", "x"),     # cervical -> cervix
        ("tic", "sis"),   # neurotic -> neurosis
        ("ous", "us"),    # nervous -> nervus
        ("ary", "a"),     # maxillary -> maxilla
        ("ic", "is"),     # pelvic -> pelvis
        ("al", "a"),      # vertebral -> vertebra
        ("ar", "a"),      # patellar -> patella
        ("iful", "y"),       # beautiful -> beauty
        ("ful", ""),         # peaceful -> peace
        ("tive", "tion"),    # proactive -> proaction
        ("sive", "sion"),    # explosive -> explosion
        ("able", "ability"), # capable -> capability
        ("ible", "ibility"), # flexible -> flexibility
        ("ent", "ence"),     # silent -> silence
        ("ant", "ance"),     # hesitant -> hesitance
        ("ar", "arity"),     # regular -> regularity
        ("y", "iness"),      # angry -> angriness
    ]
    
    for a_suffix, n_suffix in adj_rules:
        if _word.endswith(a_suffix) and len(_word) - len(a_suffix) >= 2:
            _word = _word[:-len(a_suffix)] + n_suffix
            was_modified = True
            break
            
    return _word if was_modified else word


def noun_to_anatomical_stem(noun:str):
    """
    Converts a singular anatomical noun into its searchable stem/root.
    Returns an empty string if the word was not modified.
    """
    stem = noun.lower().strip()
    if not stem:
        return ""
    
    # Rules ordered from longest/most specific to shortest
    noun_to_stem_rules = [
        ("cle", "c"),    # ventricle -> ventric, follicle -> follic
        ("ium", "i"),    # cranium -> crani, ilium -> ili
        ("um", ""),      # peritoneum -> peritone, ovum -> ov
        ("us", ""),      # bronchus -> bronch, nucleus -> nucle
        ("is", ""),      # pelvis -> pelv, diagnosis -> diagnos
        ("ix", "i"),     # cervix -> cervi, matrix -> matri
        ("nx", "n"),     # phalanx -> phalan, larynx -> laryn
        ("ex", "ic"),    # cortex -> cortic, apex -> apic
        ("a", ""),       # vertebra -> vertebr, scapula -> scapul, cornea -> corne
        ("y", ""),       # artery -> arter, capillary -> capillar
    ]
    
    for n_suffix, stem_suffix in noun_to_stem_rules:
        # Require a minimum stem length so we don't reduce "arm" or "leg" to nothing
        if stem.endswith(n_suffix) and len(stem) - len(n_suffix) >= 2:
            stem = stem[:-len(n_suffix)] + stem_suffix
            break
            
    return stem


def _uses_general_knowledge_(message: str) -> bool:
    '''
    Returns True when the user explicitly asks the LLM to draw on its background
    biomedical knowledge rather than (or in addition to) the Supporting Sentences.
    '''
    msg = str(message or '').strip().lower()
    if not msg:
        return False
    return bool(re.search(
        r'\b(general\s+knowledge|background\s+knowledge|your\s+knowledge|'
        r'use\s+your\s+(bio(?:medical|logical)?\s+)?knowledge|'
        r'not\s+limited\s+to\s+(supporting\s+sentences?|evidence)|'
        r'beyond\s+(supporting\s+sentences?|evidence|the\s+pathway)|'
        r'from\s+your\s+(training|knowledge)|'
        r'what\s+do\s+you\s+know|known\s+(?:in\s+literature|from\s+literature))\b',
        msg, re.IGNORECASE
    ))


def _focusON_(message: str) -> Optional[str]:
    '''
    output:
        'methods' if the message indicates a focus on experimental methods\n
        'procedures' if it indicates a focus on medical procedures.
        None if no specific focus is detected.
    '''
    msg = str(message or '').strip().lower()
    if not msg:
        return None
    if re.search(r'\b(experimental\s+methods?|methods?|methodology|protocols?|assays?|techniques?)\b', msg, re.IGNORECASE):
        return 'methods'
    if re.search(r'\b(medical\s+procedures?|procedures?|clinical\s+procedures?|interventions?)\b', msg, re.IGNORECASE):
        return 'procedures'
    return None

