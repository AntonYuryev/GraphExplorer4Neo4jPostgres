"""
Database -> Import RNEF: imports RNEF files into Neo4j and Postgres. Started by
the App (server.js, _startRnefImport) as:

  python rnef_import_runner.py <job.json>

job.json (written by the App, deleted here as soon as it has been read since it
contains database credentials):
  {
    "APIconfig":  { ... built by the App from the user's Neo4j/Postgres settings ... },
    "rnef_files": [ ... one file, or every RNEF file found in the chosen directory ... ],
    "batch_size": 50000,
    "log_file":   "<path of the log file to create>"
  }

Every message goes to stdout (the App streams it to the dialog) AND, through
the Tee class, to log_file (which the user can open after the run).
"""
import json
import os
import sys
import time
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)   # makes the `ResnetGraph...` package importable


def import_rnef(APIconfig: dict, rnef_files: list[str], batch_size=50000):
    """Reads the RNEF files in batches and imports each batch into Neo4j and Postgres.
    APIconfig: connection settings (built by the App from the user's Neo4j/Postgres settings)."""
    # imported here (not at module level) so a missing/broken dependency is raised
    # inside main()'s try block and lands in the log and the dialog
    from ResnetGraph.ElsevierAPI.api.ResnetAPI.ResnetGraph import ResnetGraph
    from ResnetGraph.ElsevierAPI.api.EmbioPSG_API.PSnx2Neo4j import neo4j_nx
    from ResnetGraph.ElsevierAPI.utils.utils import execution_time

    neo4j = neo4j_nx(APIconfig)
    start = time.time()
    total_imported = 0
    for nodes, rels in ResnetGraph.batch_read(rnef_files, batch_size=batch_size):
        total_imported += neo4j.importGraph(nodes, rels)
    print(f"Total imported count: {total_imported}")
    print(f"Total execution time: {execution_time(start)}")


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8')
        except AttributeError:
            pass

    if len(sys.argv) != 2:
        print('Usage: python rnef_import_runner.py <job.json>')
        return 2

    job_path = sys.argv[1]
    with open(job_path, 'r', encoding='utf-8') as f:
        job = json.load(f)
    try:
        os.remove(job_path)          # credentials: don't leave the file behind
    except OSError:
        pass

    api_config = job['APIconfig']
    rnef_files = job['rnef_files']
    batch_size = int(job.get('batch_size') or 50000)
    log_file = job['log_file']

    from ResnetGraph.ElsevierAPI.utils.utils import Tee
    err_stream = sys.stderr
    exit_code = 0
    with Tee(log_file):
        sys.stderr = sys.stdout      # library warnings/tracebacks also reach the log and the dialog
        try:
            print(f'Importing {len(rnef_files)} RNEF file(s), batch size {batch_size}', flush=True)
            for path in rnef_files[:5]:
                print(f'  {path}', flush=True)
            if len(rnef_files) > 5:
                print(f'  ... and {len(rnef_files) - 5} more', flush=True)
            started = time.time()

            import_rnef(api_config, rnef_files, batch_size=batch_size)

            print(f'Import finished OK in {time.time() - started:.1f}s', flush=True)
        except BaseException:
            traceback.print_exc(file=sys.stdout)
            print('Import FAILED — see the traceback above.', flush=True)
            exit_code = 1
        finally:
            sys.stderr = err_stream
    return exit_code


if __name__ == '__main__':
    sys.exit(main())
