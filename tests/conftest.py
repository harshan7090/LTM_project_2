"""
Shared pytest configuration.

The one thing this file does is keep the suite offline.

`README.md` states that the tests pass with no Ollama daemon, no API key and
no internet, and that property is load-bearing: it is what makes the
deterministic half of the system — the domain gate, the inspection rules, the
optimisers — verifiable anywhere.

Enabling dense retrieval quietly broke it. `get_knowledge_base()` now loads a
cached embedding index at import, so `_query_embedder()` started returning a
live function and every assistant test began embedding its query against
Ollama at about 6 seconds a call. The suite went from 77 seconds to over ten
minutes, and it only did so on a machine that happened to have Ollama running
with the model pulled — which is the worst kind of test dependency, because it
is invisible everywhere else.

Retrieval quality with dense enabled is measured directly in
tests/test_rag_dense.py, which skips when Ollama is unavailable.
"""
import os

os.environ.setdefault("RAG_DENSE_QUERIES", "0")
