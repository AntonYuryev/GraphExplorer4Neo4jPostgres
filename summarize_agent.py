import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple, Annotated, DefaultDict
from collections import defaultdict

from pydantic import BaseModel, ConfigDict, Field
from ResnetGraph.ElsevierAPI.api.ResnetAPI.ResnetGraph import ResnetGraph, PSObject, PSRelation, Reference, PUBYEAR, CLOSENESS
from ResnetGraph.ElsevierAPI.api.ResnetAPI.NetworkxObjects import MECHANISM,OBJECT_TYPE, EFFECT, RELATIONID, EFFECT, TITLE, SENTENCE, JOURNAL
from ResnetGraph.ElsevierAPI.api.EmbioPSG_API.PSnx2Neo4j import neo4j_nx, ANATOMICAL_CONCEPTS_NEO4J
from ResnetGraph.ElsevierAPI.utils.utils import tokenize, match_tokens, unpack


_RUNTIME: Dict[str, Any] = {} # runtime dependencies are injected at startup
_REL_TOKEN_RE = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*$')
_NLP_MARKUP_RE = re.compile(r'ID\{[^{}=]+=(.*?)\}')

def _runtime_(name: str):
    value = _RUNTIME.get(name)
    if value is None:
        raise RuntimeError(f"Summarize runtime dependency '{name}' is not configured")
    return value


def _strip_nlp_markup(text: Any) -> str:
    """Convert NLP markup like ID{4444444,66666=text} into plain text."""
    value = str(text or "")
    if "ID{" not in value:
        return value
    return _NLP_MARKUP_RE.sub(lambda m: m.group(1).strip(), value)


class ChatMessage(BaseModel):
    role: str
    content: str
    cypher: Optional[str] = None


class SummarizeRequest(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=True)
    message: str
    history: List[ChatMessage] = []
    llm: Optional[Dict[str, Any]] = None
    current_graph: Optional[Dict[str, Any]] = None
    resnet_graph: Optional[ResnetGraph] = None
    scope: Optional[str] = None
    neo4j_node_types: List[str] = []       # Neo4j node labels loaded into memory at app startup
    neo4j_relation_types: List[str] = []   # Neo4j relationship types loaded into memory at app startup
    default_context: List[PSObject] = []
    default_anatomy: List[PSObject] = []
    context_dict: Annotated[DefaultDict[str, List[PSObject]], Field(default_factory=lambda: defaultdict(list))]  # local vocab to lookup nodes by tokenized name/aliases from user messages
    neo4j : Optional[neo4j_nx] = None
    db_credentials: Optional[Dict[str, Any]] = None  # Database connection credentials from the app

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
        """Return current_graph edges where either endpoint's URN is among node_urns.

        Used by relationIDs() to pull in edges connecting selected NODES even
        when the user selected only the nodes on canvas (not the edge between
        them) — e.g. box-selecting a cluster of nodes without touching an edge.
        """
        if not node_urns:
            return []
        urns = set(node_urns)
        cg = self.current_graph if isinstance(self.current_graph, dict) else {}
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
        if self.resnet_graph:
            return self.resnet_graph

        self.neo4j = neo4j_nx(self.db_credentials or {})
        cg = self.current_graph if isinstance(self.current_graph, dict) else {}

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

        self.resnet_graph = ResnetGraph.from_rels(ps_rels)
        self.resnet_graph.set_node_annotation(urn2aliases, "Alias")
        self.resnet_graph.annotate_closeness()
        return self.resnet_graph
        
    
    def selected_rels(self) -> List[PSRelation]:
        '''
        Collects relation IDs from the current graph, either from all edges or only selected edges, depending on the scope.
        returns two lists of tuples (relationId, numRefs) for each edge found.
        '''
        cg = self.current_graph or {}
        selected_edges = []
        if self.scope == "selected":
            edges = (cg.get("selectedEdges") or [])
            selected_nodes_urns = [n.get("urn") for n in (cg.get("selectedNodes") or []) if isinstance(n, dict) and n.get("urn")]
            selected_edges = edges + (self.edges4(selected_nodes_urns) if selected_nodes_urns else [])
            #selected_edges may not have RelationIDs:
            return SummarizeRequest.edges2psrels(selected_edges)
        else:
            return []
        


    def get_graph_names(self) -> List[str]:
        cg = self.current_graph or {}
        vals: List[str] = []
        for k in ["graphName", "pathwayName", "subgraphName", 
                  "currentSubgraphName","tabName", "name", "title"]:
            v = cg.get(k)
            if isinstance(v, str) and v.strip():
                vals.append(v.strip())
        return vals


    def graph_nodes(self) -> List[PSObject]:
        if self.resnet_graph:
            return [n for n in self.resnet_graph._get_nodes() if n.objtype() in self.neo4j_node_types] if self.neo4j_node_types else self.resnet_graph._get_nodes()
        return []


    def _default_context_(self) -> tuple[List[str], List[str]]:
        if self.default_anatomy or self.default_context: 
            return list(self.default_anatomy), list(self.default_context)
        
        anatomy_nodes = set() # {PSObject} of anatomical concepts in the graph
        other_context = set() # {PSObject} of other context concepts in the graph (CellProcess, Disease, ClinicalParameter, Treatment)
        graph_nodes = self.graph_nodes()
        for node in graph_nodes:
            node_type = node.objtype()
            if node_type in ANATOMICAL_CONCEPTS_NEO4J:
                anatomy_nodes.add(node)
            elif node_type in ['CellProcess','Disease','ClinicalParameter','Treatment']:
                other_context.add(node)

        graph_nodes = sorted(graph_nodes, key=lambda n: (self.resnet_graph.degree(n.uid()), n[CLOSENESS]), reverse=True) if graph_nodes else []
        central_nodes = graph_nodes[:2] if graph_nodes else []
        other_context.update(central_nodes)

        # obtaining additional anatomy terms from other context, e.g. "lung cancer" -> "lung"
        other_context_tokens = set(unpack([tokenize(n) for n in self.get_graph_names()]))
        for concept in other_context:
            concept_names = {str(concept.name())}
            concept_names.update(concept['Alias'])
            for name in concept_names:
                tokens = tokenize(name)
                other_context_tokens.update(tokens)

        anatomy_nouns = {to_root_noun(t) for t in other_context_tokens}
        other_context_tokens.update(anatomy_nouns)

        anatomy_names = [str(a.name()) for a in anatomy_nodes]
        [anatomy_names.extend(n['Alias']) for n in anatomy_nodes if 'Alias' in n]
        anatomy_names = {n.lower() for n in anatomy_names}
        
        new_tokens = other_context_tokens - anatomy_names # all tokens from other context that are not already in the graph's anatomy nodes
        new_anatomy = self.neo4j.find_nodes_by_names(list(new_tokens), objtypes=list(ANATOMICAL_CONCEPTS_NEO4J), with_connectivity=False) if self.neo4j else []
        expanded_anatomy = set(anatomy_nodes) | set(new_anatomy)
        self.neo4j._load_children_(expanded_anatomy) if self.neo4j else []
        self.neo4j._load_children_(other_context) if self.neo4j else []

        self.default_anatomy = list(set(anatomy_nodes) | set(new_anatomy))
        self.default_context = list(other_context)

        for node in graph_nodes:
            node_name = str(node.name() or "")
            if node_name:
                tokenized_name = tokenize(node_name)
                tokenized_name_str = " ".join(tokenized_name)
                self.context_dict[tokenized_name_str].append(node)
            for alias in node['Alias']:
                if alias:
                    tokenized_alias = tokenize(alias)
                    if len(tokenized_alias) >=2:
                        tokenized_alias_str = " ".join(tokenized_alias)
                        if not tokenized_alias_str.isnumeric():
                            self.context_dict[tokenized_alias_str].append(node)
        
        return self.default_anatomy, self.default_context


    def select_refs(self, focus_edges:List[PSRelation] = [], focus_nodes: Optional[List[PSObject]] = None) -> List[Reference]:
        """
        input:
        - focus_nodes: list of nodes defining the context. 
        Functionally selects sentences containing name and aliases of focus_nodes.
        - focus_edges: list of pSRelations to filter sentences by (default is None, meaning all edges in the graph are considered)
        Returns a list of rows (dicts) to feed into the LLM for summarization.
        """
        selected_refs= set()
        graph_psrels = self.resnet_graph._psrels() if self.resnet_graph else []
        my_rels = set()
        
        for rel in focus_edges:
            selected_refs.update(rel.refs())
            my_rels.add(rel)

        if not my_rels: # fallback to all edges in the graph if no focus_edges are provided
            selected_refs.update(ref for rel in graph_psrels for ref in rel.refs())
            my_rels = set(graph_psrels)

        graph_nodes = set(self.graph_nodes())
        focus_graph_nodes = []
        focus_nodes_notin_graph = []
        for node in focus_nodes:
            if node in graph_nodes:
                focus_graph_nodes.append(node)
            else:
                focus_nodes_notin_graph.append(node)

        # adding all edges for focus nodes in the graph, even if they are not in focus_edges
        for rel in self.resnet_graph.get_neighbors_rels(focus_graph_nodes):
            selected_refs.update(rel.refs())

        search_terms = set()
        for node in focus_nodes_notin_graph:
            search_terms.add(str(node.name()).lower())
            search_terms.update(str(alias).lower() for alias in node['Alias'])

        for rel in my_rels:
            for ref in rel.refs():
                for textref, snippet in ref.snippets.items():
                    for tokenized_sentence in snippet.get('tokenized_sentence', set()):
                        if any(match_tokens(tokenized_sentence, term) for term in search_terms):
                            selected_refs.add(ref)
                            break
        
        return [ref for ref in selected_refs if ref.number_of_sentences() > 0]


    @staticmethod
    def refs2prompt(refs: List[Reference], minpubyear:int=None, maxpubyear:int=None) -> str:
        '''
        output:
        - (PMID 12345678, 2020, Journal of Biology) "Title of the paper": "This is a supporting sentence from the literature."
        - (PMID 23456789, 2019, Journal of Medicine) "
        Not for UI display, this is for LLM prompt context only. The LLM will use these sentences to generate a summary, but the output will not include these sentences verbatim.
        '''
        if not refs:
            return "(no supporting sentences were found)"
        lines = []
        my_refs = sorted(refs, key=lambda r: r.pubyear(), reverse=True)
        for ref in my_refs:
            pubyear = ref.pubyear()
            if minpubyear and pubyear and pubyear < minpubyear:
                continue
            if maxpubyear and pubyear and pubyear > maxpubyear:
                continue

            bibliography = []
            bibliography.append(ref.identifiers_str())
            if pubyear:
                bibliography.append(str(pubyear))
            journal = ref.journal()
            if journal:
                bibliography.append(journal)

            for textref, snippet in ref.snippets.items():
                anatomical_context = []
                for prop, provalues in snippet.items():
                    if prop in ANATOMICAL_CONCEPTS_NEO4J:
                        for val in provalues:
                            anatomical_context.append(val)

                for sentence_nomarkup in snippet.get('sentence_nomarkup', []):
                    if anatomical_context:
                        anatomical_context = sorted(set(anatomical_context))
                        line = f'- ({", ".join(bibliography)} [{"; ".join(anatomical_context)}]) "{ref.title()}": "{sentence_nomarkup}"'
                    else: 
                        line = f'- ({", ".join(bibliography)}) "{ref.title()}": "{sentence_nomarkup}"'
                    lines.append(line)
        return "\n".join(lines)


    def _system_prompt_(self,is_followup=False) -> str:
        '''
        Generates the system prompt for the LLM summarization task, including context, focus, and structure rules.
        output:
            intro_line, prompt, number of references used in the prompt
        '''
        skills_section = _runtime_("skills_prompt_section")("summarize", "")
        intro_line = ''
        selected_rels = self.selected_rels()
        if selected_rels:
            intro_line += f"Summary scope is {len(selected_rels)} relation(s) selected in current graph scope."

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

        if not context_nodes:
            context_nodes = self.context_dict.get(" ".join(tokenized_message[-2:]), [])
            if not context_nodes:
                context_nodes = self.context_dict.get(" ".join(tokenized_message[-1:]), [])

        if context_nodes:
            nodes_need_children = []
            for node in context_nodes:
                assert isinstance(node, PSObject)
                if not node.childs():
                    nodes_need_children.append(node)
            self.neo4j._load_children_(nodes_need_children) if self.neo4j else None

            context_nodes = set(context_nodes)
            [context_nodes.update(node.childs()) for node in context_nodes.copy()]
            use_default_context = False
        else:
            context_nodes = set(self.default_context + self.default_anatomy)
            use_default_context = True
            

        if use_default_context:
            intro_line += f"\nWill use {len(context_nodes)} default context concepts.\n"
        else:
            intro_line += f"\nWill use {len(context_nodes)} context concepts identified from your message.\n"


        refs4prompt = self.select_refs(focus_edges=selected_rels,focus_nodes=list(context_nodes))
        pubyear_range = _recent_year_range_(self.message)
        if pubyear_range:
            evidence = self.refs2prompt(refs4prompt, minpubyear=pubyear_range[0], maxpubyear=pubyear_range[1])
            intro_line += f"Will filter supporting sentences to those published between {pubyear_range[0]} and {pubyear_range[1]}.\n"
        else:
            evidence = self.refs2prompt(refs4prompt)

        focus_mode = _focusON_(self.message)
        context_name_list = sorted([str(node.name()) for node in context_nodes])
        context_names = ', '.join(context_name_list)
        focus_note = f"\n\nConcepts used for summarization: {context_names}"

        prompt = f"""
            Begin by confirming the context, then summarize  supporting sentences for those edge(s):
            ## intoduction
            {intro_line}
            ## Context description or focus
            {focus_note}
        """

        if focus_mode == "methods":
            focus_section = """
        ## Focused request: experimental methods
        The user is not asking for the standard sectioned summary. They asked for experimental methods.
        Answer only with the methods explicitly named in the supporting sentences.
        Do not write the default Molecular Cell / Physiology / Organ System report structure.
        Prioritize assay names, techniques, protocols, platforms, sample preparation, controls, and statistical methods only when they are written in the evidence.
        If the evidence does not mention methods, say that the supporting sentences do not list experimental methods.
        """
        elif focus_mode == "procedures":
            focus_section = """
        ## Focused request: medical procedures
        The user is not asking for the standard sectioned summary. They asked for medical procedures.
        Answer only with procedures explicitly named in the supporting sentences.
        Do not write the default Molecular Cell / Physiology / Organ System report structure.
        Prioritize operations, interventions, clinical measurements, and procedure-related outcomes only when they are written in the evidence.
        If the evidence does not mention procedures, say that the supporting sentences do not list medical procedures.
        """
        else:
            focus_section = ''

        structure_rules = """
        ## Default Output Structure (REQ-5) — unless the user asks for something else
        Organize your summary into these sections, IN THIS ORDER, using each one's heading verbatim:

        ### Molecular Cell
        Molecular interactions: proteins, small molecules, cell organelles, and cellular-level processes.
        Use your own biological judgement to keep this to genuinely CELLULAR-level events, not broader
        physiological/systemic entities (Disease, ClinicalParameter, whole-organ or whole-organism
        processes) even if they're mentioned in the same sentence — those belong in Physiology/Organ System
        below instead.

        ### Physiology
        Interactions between anatomical concepts (cell types, tissues, organs); molecular signaling that
        mediates intercellular communication (hormones/ligands, secreted proteins, membrane receptors);
        physiological processes and localized effector mechanisms (e.g. vasoconstriction, nerve outgrowth).

        ### Organ System
        Systemic phenotypes, organismal states, and macroscopic biological processes affecting integrated
        body function — whole-body responses like pregnancy, memory, learning, endurance.

        Rules that apply to EVERY section above:
        - Omission (REQ-4.2): if the fetched sentences have nothing applicable to a section, leave that
        section OUT of your reply entirely — never write "No information available" or similar for it.
        - Length cap (REQ-5): no more than 5 sentences per section. Be as succinct as possible.
        - Long list truncation: if a section would otherwise list many concepts, name only the first 3 and
        then say "... and N more" (or similar) rather than listing everything — the user can always ask
        you to expand a specific section's full list afterward, and you should do so in full when asked.
        - Citation rule: when a supporting sentence includes a PMID, repeat that PMID in the same bullet or
            sentence in your answer using the exact form "(PMID 12345678)" or "PMID 12345678". Prefer PMID
            citations over journal/year when both are available, and include every PMID that directly supports
            the claim whenever practical.
        - If more than one PMID supports the same claim, write them as a comma-separated list with no more than 3 numbers (for example:
            "PMID 12345678, 23456789"), never as one concatenated number.  Do not list more than 3 identifiers to support a single claim; if there are more than 3, just say "and others" after the first 3.
        - Never include internal backend identifiers (for example RelationID, edge IDs, node IDs, UUID-like keys)
            in user-facing summary text.
        - Focus on statements repeated across multiple supporting sentences, and prioritize those over single-sentence claims.

        Methods guidance:
        - If the user explicitly asks about experimental methods, prioritize only method names and
            procedure details that are explicitly named in the supporting sentences.
        - Include assays, measurement platforms, sample preparation, controls, and statistical procedures
            only when they appear in the text; do not infer missing method details from background knowledge.
        - When methods are the topic, be complete about the named methods, but still stay grounded in the
            supporting sentences and avoid broadening beyond what is written.

        Procedures guidance:
        - If the user explicitly asks about medical procedures, prioritize only procedure names and
            clinical process details that are explicitly named in the supporting sentences.
        - Include operations, interventions, clinical measurements, and procedure-related outcomes only
            when they appear in the text; do not infer missing procedure details from background knowledge.
        - When procedures are the topic, be complete about the named procedures, but still stay grounded
            in the supporting sentences and avoid broadening beyond what is written.
        """

        grounding_rules = """
        ## Strict grounding (REQ-4.1) — read this before writing anything
        You are NOT permitted to use general pre-trained/background biomedical knowledge to fill in,
        embellish, or "complete" this summary. Every claim must trace back to one of the sentences listed
        in "Supporting Sentences" below. If something isn't in those sentences, it does not go in your
        answer, full stop — not even something you're confident is true from training.
        """

        if is_followup:
            followup_rules = """
        ## Conversational follow-up (REQ-4.3)
        After your initial structured summary, the user may ask follow-up questions.
        - If the answer is present in the Supporting Sentences below, answer it directly, citing which
        sentence(s) it comes from.
        - If it is NOT present, say so explicitly ("the supporting sentences don't address that") rather
        than answering from general knowledge or guessing.
        """ 
        else:
            followup_rules = """
        ## Context-specific re-summarization (REQ-6)
        If the user asks you to re-focus the summary on a specific context (a disease, cell process, drug,
        anatomical concept, or organism), emit this action block INSTEAD OF answering directly — the
        backend will re-fetch the right evidence and hand it back to you to summarize on your next turn:

        ```json
        {"action": "resummarize", "term": "<the context word(s) the user gave>", "contextType": "title|anatomical|organism|entity"}
        ```
        """
        prompt += f"""
        ## Supporting Sentences (the ONLY information you may use)
        {evidence}\n{focus_note}\n{focus_section}\n{structure_rules}\n{grounding_rules}\n{followup_rules}\n{skills_section}"""

        return intro_line,prompt, len(refs4prompt)


def _call_summarize_llm(messages: List[Dict[str, str]], llm: Dict[str, Any], system_prompt: str, max_truncation_retries: int = 2):
    """Call the shared LLM helper, retrying if the provider truncates output.

    Summarize replies are plain prose, so a max-token cutoff can surface as a
    half-written section header or sentence. Unlike /chat, there is no tool loop
    here to naturally recover on the next turn, so retry immediately with a
    concise-complete rewrite instruction.
    """
    working_messages = list(messages)
    was_truncated = False
    for attempt in range(max_truncation_retries + 1):
        reply_text, was_truncated = _runtime_("call_llm_with_retries")(working_messages, llm, system_prompt)
        if not was_truncated:
            return reply_text, was_truncated
        if attempt < max_truncation_retries:
            return reply_text, was_truncated
        
        _runtime_("log").warning("Summarize reply hit max-token truncation (retry %d/%d)", attempt + 1, max_truncation_retries)
        working_messages = working_messages + [
            {
                "role": "assistant",
                "content": reply_text,
            },
            {
                "role": "user",
                "content": (
                    "Your previous summary was cut off by the token limit. Please rewrite the full answer "
                    "from the beginning, keeping it complete and concise enough to fit in one response."
                ),
            },
        ]
    return reply_text, was_truncated


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


def register_summarize_routes(app, runtime: Dict[str, Any]) -> None:
    _RUNTIME.clear()
    _RUNTIME.update(runtime)

    @app.post("/summarize-chat")
    def summarize_chat(req: SummarizeRequest):
        llm = _runtime_("effective_llm")(req.llm)
        is1st_turn = not req.history

        # Neo4j schema (node labels / relationship types) is loaded into memory
        # once at app startup (server.js pushes it to agent_service.py's /schema
        # endpoint) — populate it here from that shared runtime state rather
        # than requiring the frontend to resend it on every chat turn.
        req.neo4j_node_types = _runtime_("neo4j_node_types")()
        req.neo4j_relation_types = _runtime_("neo4j_relation_types")()

        req.init_resnet_graph()
        if not req.default_context or not req.default_anatomy:
            req._default_context_()

        intro_line, system_prompt, num_refs = req._system_prompt_(is_followup=not is1st_turn)
        messages: List[Dict] = [{"role": m.role, "content": m.content} for m in req.history]
        messages.append({"role": "user", "content": req.message})
        reply_text, was_truncated = _call_summarize_llm(messages, llm, system_prompt)
        reply_text = intro_line + "\n\n" + reply_text

        return {
            "reply": reply_text,
            "llm_reference_count": num_refs,
            "was_truncated": was_truncated
        }


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
