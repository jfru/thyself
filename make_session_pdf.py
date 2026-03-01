"""Generate a PDF from a therapy session markdown file."""

import sys
import re
from fpdf import FPDF


def sanitize(text: str) -> str:
    replacements = {
        "\u2014": "--",
        "\u2013": "-",
        "\u2018": "'",
        "\u2019": "'",
        "\u201c": '"',
        "\u201d": '"',
        "\u2026": "...",
        "\u2022": "-",
        "\u00a0": " ",
        "\u2192": "->",
        "\u2190": "<-",
        "\u2194": "<->",
        "\u2248": "~",
        "\u2260": "!=",
    }
    import unicodedata
    cleaned = ""
    for ch in text:
        if ch in replacements:
            cleaned += replacements[ch]
        else:
            try:
                ch.encode("latin-1")
                cleaned += ch
            except UnicodeEncodeError:
                try:
                    cleaned += unicodedata.normalize("NFKD", ch).encode("latin-1", "ignore").decode("latin-1")
                except Exception:
                    cleaned += "?"
    return cleaned
    # handled by per-char loop below


class SessionPDF(FPDF):
    def header(self):
        self.set_font("Helvetica", "I", 9)
        self.set_text_color(140, 140, 140)
        self.cell(0, 10, "thyself -- session transcript", align="R")
        self.ln(5)

    def footer(self):
        self.set_y(-15)
        self.set_font("Helvetica", "I", 8)
        self.set_text_color(140, 140, 140)
        self.cell(0, 10, f"Page {self.page_no()}/{{nb}}", align="C")


def render_markdown_to_pdf(md_path: str, pdf_path: str):
    with open(md_path, "r") as f:
        lines = f.readlines()

    pdf = SessionPDF()
    pdf.alias_nb_pages()
    pdf.set_auto_page_break(auto=True, margin=20)
    pdf.add_page()
    pdf.set_left_margin(20)
    pdf.set_right_margin(20)

    in_blockquote = False

    for line in lines:
        stripped = sanitize(line.rstrip("\n"))

        if stripped.startswith("# "):
            pdf.set_font("Helvetica", "B", 20)
            pdf.set_text_color(30, 30, 30)
            pdf.ln(5)
            pdf.cell(0, 12, stripped[2:])
            pdf.ln(10)

        elif stripped.startswith("## "):
            pdf.set_font("Helvetica", "B", 14)
            pdf.set_text_color(50, 50, 50)
            pdf.ln(6)
            pdf.cell(0, 10, stripped[3:])
            pdf.ln(8)

        elif stripped.startswith("### "):
            pdf.set_font("Helvetica", "B", 12)
            pdf.set_text_color(60, 60, 60)
            pdf.ln(4)
            pdf.cell(0, 8, stripped[4:])
            pdf.ln(6)

        elif stripped.startswith("> "):
            quote_text = stripped[2:]
            quote_text = re.sub(r"\*\*(.*?)\*\*", r"\1", quote_text)
            quote_text = re.sub(r"\*(.*?)\*", r"\1", quote_text)
            pdf.set_font("Helvetica", "I", 10)
            pdf.set_text_color(80, 80, 80)
            pdf.set_x(30)
            pdf.multi_cell(pdf.w - 50, 6, quote_text)
            pdf.ln(2)

        elif stripped.startswith("**") and stripped.endswith("**"):
            text = stripped.strip("*")
            pdf.set_font("Helvetica", "B", 11)
            pdf.set_text_color(30, 30, 30)
            pdf.ln(2)
            pdf.multi_cell(0, 6, text)
            pdf.ln(2)

        elif stripped.startswith("- "):
            text = stripped[2:]
            text = re.sub(r"\*\*(.*?)\*\*", r"\1", text)
            text = re.sub(r"\*(.*?)\*", r"\1", text)
            pdf.set_font("Helvetica", "", 10)
            pdf.set_text_color(30, 30, 30)
            x = pdf.get_x()
            pdf.set_x(25)
            pdf.cell(5, 6, "-")
            pdf.multi_cell(pdf.w - 50, 6, text)
            pdf.ln(1)

        elif re.match(r"^\d+\. ", stripped):
            text = re.sub(r"^\d+\. ", "", stripped)
            text = re.sub(r"\*\*(.*?)\*\*", r"\1", text)
            text = re.sub(r"\*(.*?)\*", r"\1", text)
            num = re.match(r"^(\d+)\. ", stripped).group(1)
            pdf.set_font("Helvetica", "", 10)
            pdf.set_text_color(30, 30, 30)
            pdf.set_x(25)
            pdf.cell(8, 6, f"{num}.")
            pdf.multi_cell(pdf.w - 53, 6, text)
            pdf.ln(1)

        elif stripped == "":
            pdf.ln(3)

        else:
            text = re.sub(r"\*\*(.*?)\*\*", r"\1", stripped)
            text = re.sub(r"\*(.*?)\*", r"\1", text)
            pdf.set_font("Helvetica", "", 10)
            pdf.set_text_color(30, 30, 30)
            pdf.multi_cell(0, 6, text)
            pdf.ln(1)

    pdf.output(pdf_path)
    print(f"Saved PDF to {pdf_path}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python make_session_pdf.py <input.md> [output.pdf]")
        sys.exit(1)
    md_path = sys.argv[1]
    pdf_path = sys.argv[2] if len(sys.argv) > 2 else md_path.replace(".md", ".pdf")
    render_markdown_to_pdf(md_path, pdf_path)
