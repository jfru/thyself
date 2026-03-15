use genpdf::elements::{Break, Paragraph, PaddedElement};
use genpdf::style::{self, StyledString};
use genpdf::{Alignment, Element, Margins, Mm};
use std::path::Path;

fn load_fonts() -> genpdf::fonts::FontFamily<genpdf::fonts::FontData> {
    let tmp = std::env::temp_dir().join("thyself-fonts");
    std::fs::create_dir_all(&tmp).ok();

    let files: &[(&str, &[u8])] = &[
        (
            "LiberationSans-Regular.ttf",
            include_bytes!("../fonts/LiberationSans-Regular.ttf"),
        ),
        (
            "LiberationSans-Bold.ttf",
            include_bytes!("../fonts/LiberationSans-Bold.ttf"),
        ),
        (
            "LiberationSans-Italic.ttf",
            include_bytes!("../fonts/LiberationSans-Italic.ttf"),
        ),
        (
            "LiberationSans-BoldItalic.ttf",
            include_bytes!("../fonts/LiberationSans-BoldItalic.ttf"),
        ),
    ];

    for (name, data) in files {
        let path = tmp.join(name);
        if !path.exists() {
            std::fs::write(&path, data).ok();
        }
    }

    genpdf::fonts::from_files(&tmp, "LiberationSans", None)
        .expect("Failed to load embedded fonts")
}

fn strip_inline_markdown(text: &str) -> String {
    let mut out = text.to_string();
    while let Some(start) = out.find("**") {
        if let Some(end) = out[start + 2..].find("**") {
            let inner = out[start + 2..start + 2 + end].to_string();
            out = format!("{}{}{}", &out[..start], inner, &out[start + 2 + end + 2..]);
        } else {
            break;
        }
    }
    while let Some(start) = out.find('*') {
        if let Some(end) = out[start + 1..].find('*') {
            let inner = out[start + 1..start + 1 + end].to_string();
            out = format!("{}{}{}", &out[..start], inner, &out[start + 1 + end + 1..]);
        } else {
            break;
        }
    }
    out
}

pub fn generate_session_pdf(markdown: &str, pdf_path: &Path) -> Result<(), String> {
    let font_family = load_fonts();
    let mut doc = genpdf::Document::new(font_family);

    doc.set_title("Thyself \u{2014} Session Summary");
    doc.set_minimal_conformance();

    let mut decorator = genpdf::SimplePageDecorator::new();
    decorator.set_margins(20);
    decorator.set_header(|_page| {
        let mut p = Paragraph::new("");
        p.push(StyledString::new(
            "thyself \u{2014} session summary",
            style::Style::new().italic().with_font_size(9),
        ));
        p.set_alignment(Alignment::Right);
        PaddedElement::new(p, Margins::trbl(0, 0, 3, 0))
    });
    doc.set_page_decorator(decorator);

    for line in markdown.lines() {
        let trimmed = line.trim_end();

        if trimmed.starts_with("# ") {
            let text = &trimmed[2..];
            let mut p = Paragraph::new("");
            p.push(StyledString::new(
                text,
                style::Style::new().bold().with_font_size(20),
            ));
            doc.push(Break::new(1.5));
            doc.push(p);
            doc.push(Break::new(2.5));
        } else if trimmed.starts_with("## ") {
            let text = &trimmed[3..];
            let mut p = Paragraph::new("");
            p.push(StyledString::new(
                text,
                style::Style::new().bold().with_font_size(14),
            ));
            doc.push(Break::new(2.0));
            doc.push(p);
            doc.push(Break::new(1.5));
        } else if trimmed.starts_with("### ") {
            let text = &trimmed[4..];
            let mut p = Paragraph::new("");
            p.push(StyledString::new(
                text,
                style::Style::new().bold().with_font_size(12),
            ));
            doc.push(Break::new(1.5));
            doc.push(p);
            doc.push(Break::new(1.0));
        } else if trimmed.starts_with("> ") {
            let text = strip_inline_markdown(&trimmed[2..]);
            let mut p = Paragraph::new("");
            p.push(StyledString::new(
                &text,
                style::Style::new().italic().with_font_size(10),
            ));
            doc.push(PaddedElement::new(p, Margins::trbl(0, 0, 0, 10)));
        } else if trimmed.starts_with("- ") {
            let text = strip_inline_markdown(&trimmed[2..]);
            let bullet = format!("\u{2013}  {}", text);
            let mut p = Paragraph::new("");
            p.push(StyledString::new(
                &bullet,
                style::Style::new().with_font_size(10),
            ));
            doc.push(PaddedElement::new(p, Margins::trbl(0, 0, 0, 5)));
        } else if trimmed.starts_with("**") && trimmed.ends_with("**") && trimmed.len() > 4 {
            let text = &trimmed[2..trimmed.len() - 2];
            let mut p = Paragraph::new("");
            p.push(StyledString::new(
                text,
                style::Style::new().bold().with_font_size(11),
            ));
            doc.push(Break::new(0.5));
            doc.push(p);
            doc.push(Break::new(0.5));
        } else if trimmed.is_empty() {
            doc.push(Break::new(1.0));
        } else if trimmed.chars().next().map_or(false, |c| c.is_ascii_digit()) {
            if let Some(dot_pos) = trimmed.find(". ") {
                let num_part = &trimmed[..dot_pos + 2];
                let text_part = strip_inline_markdown(&trimmed[dot_pos + 2..]);
                let full = format!("{}{}", num_part, text_part);
                let mut p = Paragraph::new("");
                p.push(StyledString::new(
                    &full,
                    style::Style::new().with_font_size(10),
                ));
                doc.push(PaddedElement::new(p, Margins::trbl(0, 0, 0, 5)));
            } else {
                let text = strip_inline_markdown(trimmed);
                doc.push(Paragraph::new(StyledString::new(
                    &text,
                    style::Style::new().with_font_size(10),
                )));
            }
        } else {
            let text = strip_inline_markdown(trimmed);
            doc.push(Paragraph::new(StyledString::new(
                &text,
                style::Style::new().with_font_size(10),
            )));
        }
    }

    doc.render_to_file(pdf_path)
        .map_err(|e| format!("Failed to render PDF: {}", e))
}
