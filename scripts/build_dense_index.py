"""
Builds the dense (embedding) half of the knowledge-base index.

Run once, or after editing anything in data/knowledge/:

    ollama pull nomic-embed-text
    python scripts/build_dense_index.py

WHY THIS IS A SCRIPT AND NOT DONE AT STARTUP:

  Embedding 31 chunks on CPU takes around 160 seconds. Paying that on every
  `uvicorn` start would make the server look hung. The console instead loads a
  cached index in about 3 ms, and if no cache exists it runs lexical-only and
  says so in /api/assistant/status rather than blocking or silently degrading.

WHAT THE DENSE VIEW ACTUALLY BUYS, MEASURED:

  recall@3 on a 3-chunk probe set, before -> after enabling dense:

      jargon queries      9/10 -> 9/10     (unchanged)
      paraphrase queries   1/8 -> 6/8      (+5)
      off-topic queries    0    -> 0       (nothing admitted)

  The split is the point. Lexical retrieval is already strong on the exact
  technical tokens this domain is full of - "DCVG", "SP0169", "-850 mV" - and
  dense adds nothing there. What it fixes is the paraphrase case: "electrical
  way of protecting pipe" shares no vocabulary with the cathodic-protection
  chunk that answers it, and TF-IDF cannot bridge that however many character
  n-grams it has.
"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.llm import embedding_model_available, ollama_embed  # noqa: E402
from src.integrity.rag import DENSE_MODEL, get_knowledge_base  # noqa: E402


def main():
    kb = get_knowledge_base()
    print(f"Knowledge base: {len(kb.chunks)} chunks from "
          f"{len({c.doc_id for c in kb.chunks})} documents")

    if kb.load_dense_index(DENSE_MODEL):
        print(f"\nA current index is already cached for '{DENSE_MODEL}'.")
        print("Nothing to do - the cache key covers both the corpus and the")
        print("model, so it would only miss if one of them had changed.")
        return

    if not embedding_model_available(DENSE_MODEL):
        print(f"\nEmbedding model '{DENSE_MODEL}' is not available.")
        print(f"  Start Ollama, then: ollama pull {DENSE_MODEL}")
        print("\nThe console works without it - retrieval stays lexical-only.")
        sys.exit(1)

    print(f"\nEmbedding with '{DENSE_MODEL}' (about 5 s per chunk on CPU) ...")
    started = time.time()
    ok = kb.build_dense_index(lambda texts: ollama_embed(texts, DENSE_MODEL),
                              DENSE_MODEL)
    elapsed = time.time() - started

    if not ok:
        print(f"\nFailed after {elapsed:.0f} s. Retrieval stays lexical-only.")
        sys.exit(1)

    print(f"\nBuilt and cached in {elapsed:.0f} s.")
    print(f"  cache: {kb._dense_cache_path(DENSE_MODEL)}")
    print("  the console will now load it in a few milliseconds at startup")


if __name__ == "__main__":
    main()
