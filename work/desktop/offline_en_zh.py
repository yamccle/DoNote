"""Bundled English-to-Chinese translation for PDF and video workers."""

import os
import re


MAX_SOURCE_TOKENS = 384
MAX_TARGET_TOKENS = 512
TARGET_PREFIX = ">>cmn_Hans<<"
LATIN_WORD = re.compile(r"[A-Za-z]{2,}")
HAN_CHAR = re.compile(r"[\u3400-\u9fff\uf900-\ufaff\U00020000-\U000323af]")
REPEATED_OUTPUT = re.compile(r"(.)\1{5,}|(.{2,16}?)\2{3,}")


def valid_english_to_chinese(source, answer, words):
    if not answer or answer == source:
        return False
    source_text = re.sub(r"\s+", "", source)
    answer_text = re.sub(r"\s+", "", answer)
    han = HAN_CHAR.findall(answer_text)
    if not answer_text or "\ufffd" in answer_text or (len(words) > 3 and not han):
        return False
    if REPEATED_OUTPUT.search(answer_text):
        return False
    # Han glyphs occupy more space than Latin characters in the mixed-font PDF.
    return len(answer_text) + len(han) <= max(48, len(source_text) * 1.25 + 16)


def split_tokens(tokens):
    start = 0
    while start < len(tokens):
        end = min(start + MAX_SOURCE_TOKENS, len(tokens))
        if end < len(tokens):
            for boundary in range(end, max(start, end - 40), -1):
                if tokens[boundary].startswith("▁"):
                    end = boundary
                    break
        yield tokens[start:end] + ["</s>"]
        start = end


class OfflineEnglishToChinese:
    def __init__(self, model):
        import ctranslate2
        import sentencepiece

        self.source = sentencepiece.SentencePieceProcessor(model_file=str(model / "source.spm"))
        self.target = sentencepiece.SentencePieceProcessor(model_file=str(model / "target.spm"))
        self.translator = ctranslate2.Translator(
            str(model), device="cpu", compute_type="int8",
            intra_threads=min(4, os.cpu_count() or 1),
        )

    def translate(self, texts, beam_size=3, *, guarded=False):
        batch = []
        owners = []
        parts = [[] for _ in texts]
        for index, text in enumerate(texts):
            chunks = list(split_tokens(self.source.encode(text, out_type=str)))
            batch.extend(chunks)
            owners.extend([index] * len(chunks))
        if not batch:
            return [""] * len(texts)

        decoder = {"max_decoding_length": MAX_TARGET_TOKENS}
        if guarded:
            # Bound runaway PDF paragraphs and require a natural end before
            # sending text to the layout engine.
            decoder.update(
                max_decoding_length=min(MAX_TARGET_TOKENS, max(48, 2 * max(map(len, batch)) + 16)),
                no_repeat_ngram_size=4,
                repetition_penalty=1.04,
                return_end_token=True,
            )
        results = self.translator.translate_batch(
            batch,
            target_prefix=[[TARGET_PREFIX]] * len(batch),
            max_batch_size=12,
            beam_size=beam_size,
            max_input_length=MAX_SOURCE_TOKENS + 1,
            **decoder,
        )
        eos = self.target.id_to_piece(self.target.eos_id()) if guarded else None
        for index, result in zip(owners, results):
            tokens = result.hypotheses[0]
            if guarded:
                if not tokens or tokens[-1] != eos:
                    parts[index].append("")
                    continue
                tokens = tokens[:-1]
            if tokens and tokens[0] == TARGET_PREFIX:
                tokens = tokens[1:]
            parts[index].append(self.target.decode(tokens).strip())
        return [" ".join(chunks) if chunks and all(chunks) else "" for chunks in parts]
