"""
Database -> Curate, first row ("Update RelationNumberOfReferences and RelationNumberOfSentences from Postgres"): refreshes RelationNumberOfSentences / RelationNumberOfReferences of the Neo4j
relations from Postgres (neo4j_nx.update_refcount). Started by the App (server.js, _curateStepUpdateRefcount) as:

  python curation_runner.py <job.json>

job.json (written by the App, deleted here as soon as it has been read since it
contains database credentials):
  {
    "APIconfig": { ... built by the App from the current user's Neo4j/Postgres settings ... },
    "only_greater": true      (optional, default true)
  }

Every line printed here is streamed by the App into the Curate run's messages, which it also writes to
logs/curation_logs, so this runner has no log file of its own.
"""
import json
import os
import sys
import time
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)   # makes the `ResnetGraph...` package importable


def update_refcount(APIconfig: dict, only_greater: bool = True):
    """APIconfig: connection settings built by the App from the current user's Neo4j/Postgres settings.
    only_greater: True (Database -> Curate) updates only the relations whose sentence count in Postgres exceeds
    RelationNumberOfSentences in Neo4j; False (Database -> Refresh Reference count) updates every relation whose count differs."""
    # imported here (not at module level) so a missing/broken dependency is raised
    # inside main()'s try block and lands in the run's messages
    from ResnetGraph.ElsevierAPI.api.EmbioPSG_API.PSnx2Neo4j import neo4j_nx
    from ResnetGraph.ElsevierAPI.utils.utils import execution_time

    start = time.time()
    neo4j = neo4j_nx(APIconfig)
    print(f"update_refcount(only_greater={only_greater})", flush=True)
    neo4j.update_refcount(only_greater=only_greater)
    print(f"\033[94mTotal execution time: {execution_time(start)}\033[0m", flush=True)


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8')
        except AttributeError:
            pass

    if len(sys.argv) != 2:
        print('Usage: python curation_runner.py <job.json>')
        return 2

    job_path = sys.argv[1]
    with open(job_path, 'r', encoding='utf-8') as f:
        job = json.load(f)
    try:
        os.remove(job_path)          # credentials: don't leave the file behind
    except OSError:
        pass

    sys.stderr = sys.stdout          # library warnings/tracebacks also reach the run's messages
    try:
        update_refcount(job['APIconfig'], only_greater=bool(job.get('only_greater', True)))
        return 0
    except BaseException:
        traceback.print_exc(file=sys.stdout)
        print('update_refcount FAILED — see the traceback above.', flush=True)
        return 1


if __name__ == '__main__':
    sys.exit(main())
