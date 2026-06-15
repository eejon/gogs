#!/usr/bin/env python3
import base64
import json
import os
import zlib
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple, Union

PDFObj = Union[str, bytes]


def b(s: str) -> bytes:
    return s.encode("latin-1")


@dataclass
class ObjRef:
    obj_id: int

    def pdf(self) -> str:
        return f"{self.obj_id} 0 R"


class PDFBuilder:
    def __init__(self, version: str = "1.4"):
        self.version = version
        self.objects: List[bytes] = []

    def add(self, body: PDFObj) -> ObjRef:
        data = body if isinstance(body, bytes) else b(body)
        self.objects.append(data)
        return ObjRef(len(self.objects))

    def _serialize_xref_table(self, root: ObjRef, info: Optional[ObjRef] = None) -> bytes:
        out = bytearray()
        out.extend(b(f"%PDF-{self.version}\n%\xe2\xe3\xcf\xd3\n"))

        offsets: List[int] = [0]
        for i, obj in enumerate(self.objects, start=1):
            offsets.append(len(out))
            out.extend(b(f"{i} 0 obj\n"))
            out.extend(obj)
            if not obj.endswith(b"\n"):
                out.extend(b"\n")
            out.extend(b"endobj\n")

        xref_start = len(out)
        out.extend(b(f"xref\n0 {len(self.objects) + 1}\n"))
        out.extend(b"0000000000 65535 f \n")
        for off in offsets[1:]:
            out.extend(b(f"{off:010d} 00000 n \n"))

        trailer = [f"/Size {len(self.objects) + 1}", f"/Root {root.pdf()}"]
        if info is not None:
            trailer.append(f"/Info {info.pdf()}")

        out.extend(b("trailer\n<< " + " ".join(trailer) + " >>\n"))
        out.extend(b(f"startxref\n{xref_start}\n%%EOF\n"))
        return bytes(out)

    def _serialize_xref_stream(self, root: ObjRef) -> bytes:
        # Build once, patch until offsets stabilize.
        xref_obj_id = len(self.objects) + 1
        xref_stream = b""

        for _ in range(6):
            out = bytearray()
            out.extend(b(f"%PDF-{self.version}\n%\xe2\xe3\xcf\xd3\n"))

            offsets = [0]
            for i, obj in enumerate(self.objects, start=1):
                offsets.append(len(out))
                out.extend(b(f"{i} 0 obj\n"))
                out.extend(obj)
                if not obj.endswith(b"\n"):
                    out.extend(b"\n")
                out.extend(b"endobj\n")

            xref_off = len(out)
            offsets.append(xref_off)

            # W [1 4 2]: type, offset, generation
            entries = bytearray()
            # obj 0 free
            entries.extend(bytes([0]) + (0).to_bytes(4, "big") + (65535).to_bytes(2, "big"))
            for off in offsets[1:]:
                entries.extend(bytes([1]) + int(off).to_bytes(4, "big") + (0).to_bytes(2, "big"))

            stream_dict = (
                f"<< /Type /XRef /Size {len(offsets)} /W [1 4 2] /Index [0 {len(offsets)}] "
                f"/Root {root.pdf()} /Length {len(entries)} >>\nstream\n"
            ).encode("latin-1")
            candidate = (
                b(f"{xref_obj_id} 0 obj\n")
                + stream_dict
                + bytes(entries)
                + b"\nendstream\nendobj\n"
                + b(f"startxref\n{xref_off}\n%%EOF\n")
            )

            new_out = bytes(out) + candidate
            if new_out == xref_stream:
                return new_out
            xref_stream = new_out

        return xref_stream

    def build(self, root: ObjRef, xref_stream: bool = False) -> bytes:
        if xref_stream:
            return self._serialize_xref_stream(root)
        return self._serialize_xref_table(root)


def stream_obj(dictionary: str, payload: bytes) -> bytes:
    d = dictionary.strip()
    if not d.startswith("<<"):
        d = "<< " + d
    if not d.endswith(">>"):
        d = d + " >>"
    if "/Length" not in d:
        d = d[:-2] + f" /Length {len(payload)} >>"
    return b(d + "\nstream\n") + payload + b("\nendstream\n")


def write_pdf(path: str, data: bytes) -> None:
    with open(path, "wb") as f:
        f.write(data)


def mk_text_pdf(path: str, text: str, content_prefix: str = "", content_suffix: str = "") -> None:
    pdf = PDFBuilder("1.4")
    font = pdf.add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    content = (
        "q\n"
        + content_prefix
        + "BT\n/F1 24 Tf\n72 720 Td\n"
        + f"({text}) Tj\n"
        + "ET\n"
        + content_suffix
        + "Q\n"
    ).encode("latin-1")
    content_ref = pdf.add(stream_obj("<< >>", content))
    page = pdf.add(
        f"<< /Type /Page /Parent 0 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 {font.pdf()} >> >> /Contents {content_ref.pdf()} >>"
    )
    pages = pdf.add(f"<< /Type /Pages /Kids [{page.pdf()}] /Count 1 >>")

    # Patch parent
    pdf.objects[page.obj_id - 1] = pdf.objects[page.obj_id - 1].replace(b"0 0 R", b(pages.pdf()))
    catalog = pdf.add(f"<< /Type /Catalog /Pages {pages.pdf()} >>")
    write_pdf(path, pdf.build(catalog))


def mk_ascii_filtered_text_pdf(path: str, text: str, filter_name: str) -> None:
    plain = f"BT /F1 24 Tf 72 720 Td ({text}) Tj ET\n".encode("latin-1")
    if filter_name == "ASCIIHexDecode":
        encoded = plain.hex().upper().encode("ascii") + b">"
    else:
        encoded = base64.a85encode(plain, adobe=True)

    pdf = PDFBuilder("1.4")
    font = pdf.add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    content = pdf.add(stream_obj(f"<< /Filter /{filter_name} >>", encoded))
    page = pdf.add(
        f"<< /Type /Page /Parent 0 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 {font.pdf()} >> >> /Contents {content.pdf()} >>"
    )
    pages = pdf.add(f"<< /Type /Pages /Kids [{page.pdf()}] /Count 1 >>")
    pdf.objects[page.obj_id - 1] = pdf.objects[page.obj_id - 1].replace(b"0 0 R", b(pages.pdf()))
    catalog = pdf.add(f"<< /Type /Catalog /Pages {pages.pdf()} >>")
    write_pdf(path, pdf.build(catalog))


def mk_jpeg_pdf(path: str) -> None:
    # 1x1 white JPEG
    jpeg = base64.b64decode(
        b"/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAkGBxAQEBAQEA8PDw8PDw8PDw8PDw8QFRIWFhURFRUYHSggGBolGxUVITEhJSkrLi4uFx8zODMtNygtLisBCgoKDQ0NDw0NDisZFRkrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrK//AABEIAAEAAgMBIgACEQEDEQH/xAAXAAADAQAAAAAAAAAAAAAAAAAAAQID/8QAFhABAQEAAAAAAAAAAAAAAAAAAAER/9oADAMBAAIQAxAAAAGWj//EABQQAQAAAAAAAAAAAAAAAAAAACD/2gAIAQEAAQUCcf/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8Bp//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8Bp//Z"
    )

    pdf = PDFBuilder("1.4")
    font = pdf.add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    img = pdf.add(
        stream_obj(
            "<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode >>",
            jpeg,
        )
    )
    content_bytes = (
        b"q\n200 0 0 200 100 500 cm\n/Im1 Do\nQ\nBT /F1 14 Tf 72 460 Td (JPEG XObject) Tj ET\n"
    )
    content = pdf.add(stream_obj("<< >>", content_bytes))
    page = pdf.add(
        f"<< /Type /Page /Parent 0 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 {font.pdf()} >> /XObject << /Im1 {img.pdf()} >> >> /Contents {content.pdf()} >>"
    )
    pages = pdf.add(f"<< /Type /Pages /Kids [{page.pdf()}] /Count 1 >>")
    pdf.objects[page.obj_id - 1] = pdf.objects[page.obj_id - 1].replace(b"0 0 R", b(pages.pdf()))
    catalog = pdf.add(f"<< /Type /Catalog /Pages {pages.pdf()} >>")
    write_pdf(path, pdf.build(catalog))


def mk_inline_image_pdf(path: str) -> None:
    # 2x2 RGB inline image: red, green, blue, white
    pixels = bytes([
        255, 0, 0,
        0, 255, 0,
        0, 0, 255,
        255, 255, 255,
    ])
    content = (
        b"q\n200 0 0 200 100 500 cm\nBI\n/W 2\n/H 2\n/BPC 8\n/CS /RGB\nID\n"
        + pixels
        + b"\nEI\nQ\n"
    )
    pdf = PDFBuilder("1.4")
    content_ref = pdf.add(stream_obj("<< >>", content))
    page = pdf.add(
        f"<< /Type /Page /Parent 0 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents {content_ref.pdf()} >>"
    )
    pages = pdf.add(f"<< /Type /Pages /Kids [{page.pdf()}] /Count 1 >>")
    pdf.objects[page.obj_id - 1] = pdf.objects[page.obj_id - 1].replace(b"0 0 R", b(pages.pdf()))
    catalog = pdf.add(f"<< /Type /Catalog /Pages {pages.pdf()} >>")
    write_pdf(path, pdf.build(catalog))


def mk_predictor_pdf(path: str) -> None:
    # 2x2 gray image, Predictor 12 (PNG Up)
    # raw pixels row1: [50, 200], row2: [100, 150]
    filtered = bytes([2, 50, 200, 2, 50, 206])  # row2 up filter: (100-50, 150-200 mod 256)
    payload = zlib.compress(filtered)

    pdf = PDFBuilder("1.4")
    img = pdf.add(
        stream_obj(
            "<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /DecodeParms << /Predictor 12 /Colors 1 /BitsPerComponent 8 /Columns 2 >> >>",
            payload,
        )
    )
    content = pdf.add(stream_obj("<< >>", b"q\n200 0 0 200 100 500 cm\n/Im1 Do\nQ\n"))
    page = pdf.add(
        f"<< /Type /Page /Parent 0 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 {img.pdf()} >> >> /Contents {content.pdf()} >>"
    )
    pages = pdf.add(f"<< /Type /Pages /Kids [{page.pdf()}] /Count 1 >>")
    pdf.objects[page.obj_id - 1] = pdf.objects[page.obj_id - 1].replace(b"0 0 R", b(pages.pdf()))
    catalog = pdf.add(f"<< /Type /Catalog /Pages {pages.pdf()} >>")
    write_pdf(path, pdf.build(catalog))


def mk_bpc_1_pdf(path: str) -> None:
    # 8x2 1bpc image, two checker rows
    # row bytes: 10101010 and 01010101
    raw = bytes([0b10101010, 0b01010101])
    payload = zlib.compress(raw)

    pdf = PDFBuilder("1.4")
    img = pdf.add(
        stream_obj(
            "<< /Type /XObject /Subtype /Image /Width 8 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /FlateDecode >>",
            payload,
        )
    )
    content = pdf.add(stream_obj("<< >>", b"q\n300 0 0 100 100 500 cm\n/Im1 Do\nQ\n"))
    page = pdf.add(
        f"<< /Type /Page /Parent 0 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 {img.pdf()} >> >> /Contents {content.pdf()} >>"
    )
    pages = pdf.add(f"<< /Type /Pages /Kids [{page.pdf()}] /Count 1 >>")
    pdf.objects[page.obj_id - 1] = pdf.objects[page.obj_id - 1].replace(b"0 0 R", b(pages.pdf()))
    catalog = pdf.add(f"<< /Type /Catalog /Pages {pages.pdf()} >>")
    write_pdf(path, pdf.build(catalog))


def mk_colors_pdf(path: str) -> None:
    content = b"\n".join(
        [
            b"q",
            b"0 1 1 0 k",  # CMYK red-ish
            b"72 650 200 80 re f",
            b"0.2 g",
            b"72 550 200 80 re f",
            b"0 0 1 rg",
            b"72 450 200 80 re f",
            b"Q",
            b"",
        ]
    )
    pdf = PDFBuilder("1.4")
    c = pdf.add(stream_obj("<< >>", content))
    page = pdf.add(f"<< /Type /Page /Parent 0 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents {c.pdf()} >>")
    pages = pdf.add(f"<< /Type /Pages /Kids [{page.pdf()}] /Count 1 >>")
    pdf.objects[page.obj_id - 1] = pdf.objects[page.obj_id - 1].replace(b"0 0 R", b(pages.pdf()))
    catalog = pdf.add(f"<< /Type /Catalog /Pages {pages.pdf()} >>")
    write_pdf(path, pdf.build(catalog))


def mk_alpha_extgstate_pdf(path: str) -> None:
    pdf = PDFBuilder("1.4")
    gs = pdf.add("<< /Type /ExtGState /ca 0.3 /CA 0.3 >>")
    content = b"\n".join(
        [
            b"q",
            b"1 0 0 rg",
            b"72 600 250 120 re f",
            b"/GS1 gs",
            b"0 0 1 rg",
            b"140 640 250 120 re f",
            b"Q",
            b"",
        ]
    )
    c = pdf.add(stream_obj("<< >>", content))
    page = pdf.add(
        f"<< /Type /Page /Parent 0 0 R /MediaBox [0 0 612 792] /Resources << /ExtGState << /GS1 {gs.pdf()} >> >> /Contents {c.pdf()} >>"
    )
    pages = pdf.add(f"<< /Type /Pages /Kids [{page.pdf()}] /Count 1 >>")
    pdf.objects[page.obj_id - 1] = pdf.objects[page.obj_id - 1].replace(b"0 0 R", b(pages.pdf()))
    catalog = pdf.add(f"<< /Type /Catalog /Pages {pages.pdf()} >>")
    write_pdf(path, pdf.build(catalog))


def mk_shading_pdf(path: str) -> None:
    pdf = PDFBuilder("1.4")
    func = pdf.add("<< /FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [0 0 1] /N 1 >>")
    sh = pdf.add(
        f"<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [72 650 300 650] /Function {func.pdf()} /Extend [true true] >>"
    )
    content = pdf.add(stream_obj("<< >>", b"q\n/Sh1 sh\nQ\n"))
    page = pdf.add(
        f"<< /Type /Page /Parent 0 0 R /MediaBox [0 0 612 792] /Resources << /Shading << /Sh1 {sh.pdf()} >> >> /Contents {content.pdf()} >>"
    )
    pages = pdf.add(f"<< /Type /Pages /Kids [{page.pdf()}] /Count 1 >>")
    pdf.objects[page.obj_id - 1] = pdf.objects[page.obj_id - 1].replace(b"0 0 R", b(pages.pdf()))
    catalog = pdf.add(f"<< /Type /Catalog /Pages {pages.pdf()} >>")
    write_pdf(path, pdf.build(catalog))


def mk_link_pdf(path: str, uri: str) -> None:
    pdf = PDFBuilder("1.4")
    font = pdf.add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    content = pdf.add(stream_obj("<< >>", b"BT /F1 18 Tf 72 720 Td (Click region below) Tj ET\n"))
    action = pdf.add(f"<< /Type /Action /S /URI /URI ({uri}) >>")
    annot = pdf.add(
        f"<< /Type /Annot /Subtype /Link /Rect [72 680 260 710] /Border [0 0 1] /A {action.pdf()} >>"
    )
    page = pdf.add(
        f"<< /Type /Page /Parent 0 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 {font.pdf()} >> >> /Contents {content.pdf()} /Annots [{annot.pdf()}] >>"
    )
    pages = pdf.add(f"<< /Type /Pages /Kids [{page.pdf()}] /Count 1 >>")
    pdf.objects[page.obj_id - 1] = pdf.objects[page.obj_id - 1].replace(b"0 0 R", b(pages.pdf()))
    catalog = pdf.add(f"<< /Type /Catalog /Pages {pages.pdf()} >>")
    write_pdf(path, pdf.build(catalog))


def mk_js_action_pdf(path: str) -> None:
    pdf = PDFBuilder("1.4")
    font = pdf.add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    js = pdf.add("<< /S /JavaScript /JS (app.alert('owned')) >>")
    content = pdf.add(stream_obj("<< >>", b"BT /F1 18 Tf 72 720 Td (JavaScript action test) Tj ET\n"))
    page = pdf.add("<< /Type /Page /Parent 0 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 1 0 R >> >> /Contents 3 0 R >>")
    pages = pdf.add(f"<< /Type /Pages /Kids [{page.pdf()}] /Count 1 >>")
    pdf.objects[page.obj_id - 1] = pdf.objects[page.obj_id - 1].replace(b"0 0 R", b(pages.pdf()))
    catalog = pdf.add(f"<< /Type /Catalog /Pages {pages.pdf()} /OpenAction {js.pdf()} >>")
    write_pdf(path, pdf.build(catalog))


def mk_launch_action_pdf(path: str) -> None:
    pdf = PDFBuilder("1.4")
    font = pdf.add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    launch = pdf.add("<< /S /Launch /F (calc.exe) >>")
    content = pdf.add(stream_obj("<< >>", b"BT /F1 18 Tf 72 720 Td (Launch action test) Tj ET\n"))
    annot = pdf.add(f"<< /Type /Annot /Subtype /Link /Rect [72 680 260 710] /A {launch.pdf()} >>")
    page = pdf.add(
        f"<< /Type /Page /Parent 0 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 {font.pdf()} >> >> /Contents {content.pdf()} /Annots [{annot.pdf()}] >>"
    )
    pages = pdf.add(f"<< /Type /Pages /Kids [{page.pdf()}] /Count 1 >>")
    pdf.objects[page.obj_id - 1] = pdf.objects[page.obj_id - 1].replace(b"0 0 R", b(pages.pdf()))
    catalog = pdf.add(f"<< /Type /Catalog /Pages {pages.pdf()} >>")
    write_pdf(path, pdf.build(catalog))


def mk_multipage_inherit_pdf(path: str) -> None:
    pdf = PDFBuilder("1.4")
    font = pdf.add("<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>")
    c1 = pdf.add(stream_obj("<< >>", b"BT /F1 20 Tf 72 720 Td (Page 1 inherited resources) Tj ET\n"))
    c2 = pdf.add(stream_obj("<< >>", b"BT /F1 20 Tf 72 720 Td (Page 2 inherited resources) Tj ET\n"))
    p1 = pdf.add(f"<< /Type /Page /Parent 0 0 R /MediaBox [0 0 612 792] /Contents {c1.pdf()} >>")
    p2 = pdf.add(f"<< /Type /Page /Parent 0 0 R /MediaBox [0 0 612 792] /Contents {c2.pdf()} >>")
    pages = pdf.add(
        f"<< /Type /Pages /Kids [{p1.pdf()} {p2.pdf()}] /Count 2 /Resources << /Font << /F1 {font.pdf()} >> >> >>"
    )
    pdf.objects[p1.obj_id - 1] = pdf.objects[p1.obj_id - 1].replace(b"0 0 R", b(pages.pdf()))
    pdf.objects[p2.obj_id - 1] = pdf.objects[p2.obj_id - 1].replace(b"0 0 R", b(pages.pdf()))
    catalog = pdf.add(f"<< /Type /Catalog /Pages {pages.pdf()} >>")
    write_pdf(path, pdf.build(catalog))


def mk_xref_stream_pdf(path: str) -> None:
    pdf = PDFBuilder("1.5")
    font = pdf.add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    c = pdf.add(stream_obj("<< >>", b"BT /F1 22 Tf 72 720 Td (XRef stream PDF) Tj ET\n"))
    p = pdf.add(
        f"<< /Type /Page /Parent 0 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 {font.pdf()} >> >> /Contents {c.pdf()} >>"
    )
    pages = pdf.add(f"<< /Type /Pages /Kids [{p.pdf()}] /Count 1 >>")
    pdf.objects[p.obj_id - 1] = pdf.objects[p.obj_id - 1].replace(b"0 0 R", b(pages.pdf()))
    catalog = pdf.add(f"<< /Type /Catalog /Pages {pages.pdf()} >>")
    write_pdf(path, pdf.build(catalog, xref_stream=True))


def mk_malformed_truncated_pdf(path: str) -> None:
    # Start with valid file and truncate xref tail.
    tmp = path + ".tmp"
    mk_text_pdf(tmp, "Truncated file")
    with open(tmp, "rb") as f:
        data = f.read()
    os.remove(tmp)
    cut = max(50, len(data) - 90)
    with open(path, "wb") as f:
        f.write(data[:cut])


def main() -> None:
    out_dir = os.path.dirname(__file__)

    fixtures: List[Tuple[str, str]] = [
        ("m01-basic-text.pdf", "basic text + classic parser path"),
        ("m02-text-transform-spacing.pdf", "text matrix/spacing/graphics state"),
        ("m03-path-clip-color.pdf", "paths, paint, clip, colors"),
        ("m04-jpeg-xobject.pdf", "JPEG XObject rendering"),
        ("m05-inline-image.pdf", "inline image BI/ID/EI"),
        ("m06-flate-predictor12.pdf", "Flate image with PNG Up predictor"),
        ("m07-bpc1-image.pdf", "1-bit image decoding"),
        ("m08-colorspaces-cmyk-rgb-gray.pdf", "device color spaces"),
        ("m09-asciihex-content.pdf", "ASCIIHex stream decode"),
        ("m10-ascii85-content.pdf", "ASCII85 stream decode"),
        ("m11-extgstate-alpha.pdf", "ExtGState transparency"),
        ("m12-shading-axial.pdf", "axial shading"),
        ("m13-links-safe-uri.pdf", "safe URI link"),
        ("m14-links-javascript-uri.pdf", "blocked javascript URI"),
        ("m15-openaction-javascript.pdf", "strip /JavaScript open action"),
        ("m16-launch-action.pdf", "block /Launch action"),
        ("m17-multipage-inherit.pdf", "page tree and inherited resources"),
        ("m18-xref-stream.pdf", "xref stream support"),
        ("m19-malformed-truncated.pdf", "malformed/truncated resilience"),
    ]

    mk_text_pdf(os.path.join(out_dir, "m01-basic-text.pdf"), "Metric batch: basic text")
    mk_text_pdf(
        os.path.join(out_dir, "m02-text-transform-spacing.pdf"),
        "Transform + spacing",
        content_prefix="1 0 0 1 0 0 cm\nBT\n/F1 12 Tf\n72 700 Td\n(First line) Tj\nT*\n(Second line) Tj\nET\nq\n0.5 0 0 0.5 300 500 cm\n",
        content_suffix="Q\n",
    )
    mk_text_pdf(
        os.path.join(out_dir, "m03-path-clip-color.pdf"),
        "Path clip color",
        content_prefix="0 1 0 rg\n72 620 300 120 re f\nq\n72 620 300 120 re W n\n1 0 0 rg\n72 620 m 372 740 l 372 620 l h f\nQ\n",
    )
    mk_jpeg_pdf(os.path.join(out_dir, "m04-jpeg-xobject.pdf"))
    mk_inline_image_pdf(os.path.join(out_dir, "m05-inline-image.pdf"))
    mk_predictor_pdf(os.path.join(out_dir, "m06-flate-predictor12.pdf"))
    mk_bpc_1_pdf(os.path.join(out_dir, "m07-bpc1-image.pdf"))
    mk_colors_pdf(os.path.join(out_dir, "m08-colorspaces-cmyk-rgb-gray.pdf"))
    mk_ascii_filtered_text_pdf(os.path.join(out_dir, "m09-asciihex-content.pdf"), "ASCIIHEX", "ASCIIHexDecode")
    mk_ascii_filtered_text_pdf(os.path.join(out_dir, "m10-ascii85-content.pdf"), "ASCII85", "ASCII85Decode")
    mk_alpha_extgstate_pdf(os.path.join(out_dir, "m11-extgstate-alpha.pdf"))
    mk_shading_pdf(os.path.join(out_dir, "m12-shading-axial.pdf"))
    mk_link_pdf(os.path.join(out_dir, "m13-links-safe-uri.pdf"), "https://example.com")
    mk_link_pdf(os.path.join(out_dir, "m14-links-javascript-uri.pdf"), "javascript:alert(1)")
    mk_js_action_pdf(os.path.join(out_dir, "m15-openaction-javascript.pdf"))
    mk_launch_action_pdf(os.path.join(out_dir, "m16-launch-action.pdf"))
    mk_multipage_inherit_pdf(os.path.join(out_dir, "m17-multipage-inherit.pdf"))
    mk_xref_stream_pdf(os.path.join(out_dir, "m18-xref-stream.pdf"))
    mk_malformed_truncated_pdf(os.path.join(out_dir, "m19-malformed-truncated.pdf"))

    manifest = {
        "name": "pdf-metric-batch",
        "version": "1.0.0",
        "description": "Targeted PDF fixtures mapped to pdf-functional-test-metric rows.",
        "files": [
            {
                "file": "m01-basic-text.pdf",
                "targets": ["P03", "P04", "P06", "R01", "R02"],
                "expectation": "renders readable text with standard font",
            },
            {
                "file": "m02-text-transform-spacing.pdf",
                "targets": ["R03", "R04"],
                "expectation": "text transforms and line stepping are applied correctly",
            },
            {
                "file": "m03-path-clip-color.pdf",
                "targets": ["R05"],
                "expectation": "clip path and fill colors are respected",
            },
            {
                "file": "m04-jpeg-xobject.pdf",
                "targets": ["R06"],
                "expectation": "JPEG image XObject is decoded and drawn",
            },
            {
                "file": "m05-inline-image.pdf",
                "targets": ["R11"],
                "expectation": "inline BI/ID/EI image renders",
            },
            {
                "file": "m06-flate-predictor12.pdf",
                "targets": ["P08", "R07"],
                "expectation": "Flate image decode with Predictor=12 works",
            },
            {
                "file": "m07-bpc1-image.pdf",
                "targets": ["R08"],
                "expectation": "1bpc image is decoded into visible pattern",
            },
            {
                "file": "m08-colorspaces-cmyk-rgb-gray.pdf",
                "targets": ["R09"],
                "expectation": "DeviceCMYK/DeviceRGB/DeviceGray rendering is plausible",
            },
            {
                "file": "m09-asciihex-content.pdf",
                "targets": ["P09"],
                "expectation": "ASCIIHexDecode content stream is decoded",
            },
            {
                "file": "m10-ascii85-content.pdf",
                "targets": ["P09"],
                "expectation": "ASCII85Decode content stream is decoded",
            },
            {
                "file": "m11-extgstate-alpha.pdf",
                "targets": ["R12"],
                "expectation": "ExtGState alpha compositing is visible",
            },
            {
                "file": "m12-shading-axial.pdf",
                "targets": ["R13"],
                "expectation": "axial shading or safe fallback is handled",
            },
            {
                "file": "m13-links-safe-uri.pdf",
                "targets": ["V04", "S02"],
                "expectation": "safe HTTPS link is preserved with safe attributes",
            },
            {
                "file": "m14-links-javascript-uri.pdf",
                "targets": ["S02"],
                "expectation": "javascript: URI is blocked/removed",
            },
            {
                "file": "m15-openaction-javascript.pdf",
                "targets": ["S01"],
                "expectation": "OpenAction JavaScript is stripped and never executed",
            },
            {
                "file": "m16-launch-action.pdf",
                "targets": ["S03"],
                "expectation": "/Launch action is blocked/removed",
            },
            {
                "file": "m17-multipage-inherit.pdf",
                "targets": ["P10", "V01"],
                "expectation": "2 pages render and inherited resources resolve",
            },
            {
                "file": "m18-xref-stream.pdf",
                "targets": ["P05"],
                "expectation": "parser resolves xref stream file",
            },
            {
                "file": "m19-malformed-truncated.pdf",
                "targets": ["S04", "S05"],
                "expectation": "graceful failure without crash/hang",
            },
        ],
        "notes": [
            "P01/P02/V02/V03/V05/S06 are viewer/runtime behaviors and must be validated by harness checks in addition to file fixtures.",
            "R10 (ImageMask + SMask) is not isolated in this first batch and should be added as a second-pass fixture if needed.",
        ],
    }

    with open(os.path.join(out_dir, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)

    with open(os.path.join(out_dir, "README.md"), "w", encoding="utf-8") as f:
        f.write(
            "# PDF Metric Batch\n\n"
            "Generated targeted PDF fixtures mapped to `.claude/agents-memory/checkpoints/pdf-functional-test-metric.md`.\n\n"
            "Regenerate:\n\n"
            "```bash\n"
            "python3 tests/corpus/metric-batch/generate_metric_batch.py\n"
            "```\n"
        )

    print(f"Generated {len(fixtures)} PDFs in {out_dir}")


if __name__ == "__main__":
    main()
