/**
 * DOCX Document Template v2 — Factory Pattern
 *
 * Usage: const createTemplate = require('./professional');
 *        const t = createTemplate(themeConfig);
 */

const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  HeadingLevel, BorderStyle, WidthType, ShadingType, AlignmentType,
  LevelFormat, PageBreak, ImageRun, Header, Footer, PageNumber, TabStopType, TabStopPosition,
  TableOfContents
} = require('docx');
const fs = require('fs');
const path = require('path');

// ============================================================
// Defaults (used when no theme is provided — backward compatible)
// ============================================================

const DEFAULT_COLORS = {
  primary: "1B3664",
  secondary: "2B5598",
  accent: "F5A623",
  text: "333333",
  textLight: "666666",
  textDark: "404040",
  white: "FFFFFF",
  border: "CCCCCC",
  codeBorder: "BFBFBF",
  altRow: "F2F2F2",
  codeBlock: "EAEAEA",
  infoBox: "E8F0F7",
  warningBox: "FEF6E6",
  infoBoxBorder: "1B3664",
  warningBoxBorder: "F5A623",
  warningBoxText: "8B4513",
  inlineCode: "555555",
  headerFooter: "666666",
  codeDarkBg: "1E1E1E",
  codeDarkBorder: "3C3C3C",
  jsonBg: "F5F5F5",
  flowBoxBorder: "666666",
  flowBoxBg: "F5F5F5",
  flowBlockBorder: "D0D0D0",
  flowBlockBg: "FAFAFA"
};

const DEFAULT_FONTS = { default: "Malgun Gothic", code: "Consolas" };
const DEFAULT_SIZES = { title: 48, subtitle: 26, h1: 28, h2: 24, h3: 22, h4: 20, body: 20, small: 18, code: 16 };
const DEFAULT_SYNTAX = {
  keyword: "569CD6",
  annotation: "DCDCAA",
  type: "4EC9B0",
  string: "CE9178",
  number: "B5CEA8",
  comment: "6A9955",
  default: "D4D4D4"
};

// ============================================================
// Factory Function
// ============================================================

function createTemplate(theme = {}) {
  const _COLORS = { ...DEFAULT_COLORS, ...(theme.colors || {}) };
  const _FONTS = { ...DEFAULT_FONTS, ...(theme.fonts || {}) };
  const _SIZES = { ...DEFAULT_SIZES, ...(theme.sizes || {}) };
  const _SYNTAX = { ...DEFAULT_SYNTAX, ...(theme.syntax || {}) };

  // 확장 슬롯: spacing, code, header, footer, cover (null → 기존 하드코딩 fallback)
  const _spacing = { h1: { before: 400, after: 200 }, h2: { before: 300, after: 150 },
    h3: { before: 200, after: 100 }, h4: { before: 150, after: 80 }, ...(theme.spacing || {}) };
  const _code = { mode: 'dark', lightBg: 'F5F5F5', lightBorder: 'BFBFBF', borderWidth: null, ...(theme.code || {}) };
  const _header = { text: null, border: false, ...(theme.header || {}) };
  const _footer = { format: null, ...(theme.footer || {}) };
  const _cover = { style: 'default', logoWidth: 180, logoHeight: 54, titleSize: null, ...(theme.cover || {}) };

  // Orientation support: 'landscape' (default) or 'portrait'
  const _orientation = theme.orientation || 'landscape';
  const _isPortrait = _orientation === 'portrait';
  const _contentWidth = _isPortrait ? 9360 : 12960;  // DXA
  const _rightTab = _isPortrait ? 9900 : 13500;

  // 테이블 헤더: 독립 슬롯 (null → 기존 동작 fallback)
  const _tableHeaderBg = _COLORS.tableHeaderBg || _COLORS.primary;
  const _tableHeaderText = _COLORS.tableHeaderText || _COLORS.white;
  const _tableHeaderBold = _COLORS.tableHeaderBold !== false; // null/undefined → true
  const _tableHeaderAlign = _COLORS.tableHeaderAlign || null; // null → 기존 (left)

  // 헤딩 색상: 레벨별 독립 슬롯 (null → 기존 색상 fallback)
  const _h1Color = _COLORS.h1Color || _COLORS.primary;
  const _h2Color = _COLORS.h2Color || _COLORS.secondary;
  const _h3Color = _COLORS.h3Color || _COLORS.textDark;
  const _h4Color = _COLORS.h4Color || _COLORS.text;

  // Derived values
  const _border = { style: BorderStyle.SINGLE, size: 1, color: _COLORS.border };
  const _borders = { top: _border, bottom: _border, left: _border, right: _border };
  const _codeBorder = { style: BorderStyle.SINGLE, size: 1, color: _COLORS.codeBorder };
  const _headerShading = { fill: _tableHeaderBg, type: ShadingType.CLEAR };
  const _altShading = { fill: _COLORS.altRow, type: ShadingType.CLEAR };
  const _codeShading = { fill: _COLORS.codeBlock, type: ShadingType.CLEAR };
  const _cellMargins = _isPortrait
    ? { top: 60, bottom: 60, left: 80, right: 80 }
    : { top: 80, bottom: 80, left: 120, right: 120 };

  // 테이블 글꼴 크기: 독립 슬롯 (null → 기존 자동 계산 fallback)
  const _tableBodySize = _SIZES.tableBody || (_isPortrait ? Math.max(_SIZES.small - 2, 14) : _SIZES.small);
  const _tableHeaderSize = _SIZES.tableHeader || _tableBodySize;

  const _docStyles = {
    default: { document: { run: { font: _FONTS.default, size: _SIZES.body } } },
    paragraphStyles: [
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: _SIZES.h1, bold: true, font: _FONTS.default, color: _h1Color },
        paragraph: { spacing: _spacing.h1, outlineLevel: 0 } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: _SIZES.h2, bold: true, font: _FONTS.default, color: _h2Color },
        paragraph: { spacing: _spacing.h2, outlineLevel: 1 } },
      { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: _SIZES.h3, bold: true, font: _FONTS.default, color: _h3Color },
        paragraph: { spacing: _spacing.h3, outlineLevel: 2 } },
      { id: "Heading4", name: "Heading 4", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: _SIZES.h4 || _SIZES.body, bold: true, font: _FONTS.default, color: _h4Color },
        paragraph: { spacing: _spacing.h4, outlineLevel: 3 } }
    ]
  };

  const _numbering = {
    config: [{
      reference: "bullets",
      levels: [{ level: 0, format: LevelFormat.BULLET, text: "\u2022", alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 720, hanging: 360 } } } }]
    }]
  };

  const _pageSettings = {
    page: {
      size: _isPortrait
        ? { width: 12240, height: 15840 }   // Portrait A4
        : { width: 15840, height: 12240 },   // Landscape A4
      margin: { top: 1080, right: 1440, bottom: 1080, left: 1440 }
    }
  };

  // ============================================================
  // Internal helpers
  // ============================================================

  function _headerCell(text, width) {
    const align = _tableHeaderAlign === 'center' ? AlignmentType.CENTER : undefined;
    return new TableCell({
      borders: _borders, width: { size: width, type: WidthType.DXA }, shading: _headerShading, margins: _cellMargins,
      children: [new Paragraph({ alignment: align, children: [new TextRun({ text, bold: _tableHeaderBold, color: _tableHeaderText, font: _FONTS.default, size: _tableHeaderSize })] })]
    });
  }

  function _bodyCell(text, width, useAlt = false) {
    return new TableCell({
      borders: _borders, width: { size: width, type: WidthType.DXA }, shading: useAlt ? _altShading : null, margins: _cellMargins,
      children: [new Paragraph({ children: parseInlineFormatting(text, _tableBodySize) })]
    });
  }

  function _headerCellCenter(text, width) {
    return new TableCell({
      borders: _borders, width: { size: width, type: WidthType.DXA }, shading: _headerShading, margins: _cellMargins,
      children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text, bold: _tableHeaderBold, color: _tableHeaderText, font: _FONTS.default, size: _tableHeaderSize })] })]
    });
  }

  function _bodyCellCenter(text, width, useAlt = false) {
    return new TableCell({
      borders: _borders, width: { size: width, type: WidthType.DXA }, shading: useAlt ? _altShading : null, margins: _cellMargins,
      children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text, font: _FONTS.default, size: _tableBodySize })] })]
    });
  }

  // ============================================================
  // Public API — Text elements
  // ============================================================

  function h1(content) {
    return new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(content)] });
  }

  function h2(content) {
    return new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(content)] });
  }

  function h3(content) {
    return new Paragraph({ heading: HeadingLevel.HEADING_3, children: [new TextRun(content)] });
  }

  function h4(content) {
    return new Paragraph({ heading: HeadingLevel.HEADING_4, children: [new TextRun(content)] });
  }

  function text(content, options = {}) {
    const fontSize = options.size || _SIZES.body;
    const textColor = options.color || _COLORS.text;
    let children;
    if (options.bold) {
      // 전체 bold 지정 시 기존 동작 유지
      children = [new TextRun({ text: content, font: _FONTS.default, size: fontSize, bold: true, italics: options.italics || false, color: textColor })];
    } else {
      // 인라인 bold/code 파싱
      children = parseInlineFormatting(content, fontSize, textColor);
    }
    return new Paragraph({ spacing: options.spacing || {}, children });
  }

  function parseInlineFormatting(textContent, fontSize = _SIZES.body, textColor = _COLORS.text) {
    const parts = textContent.split(/(\*\*[^*]+\*\*|`[^`]+`)/);
    return parts.filter(p => p).map(part => {
      if (part.startsWith('**') && part.endsWith('**')) {
        return new TextRun({ text: part.slice(2, -2), font: _FONTS.default, size: fontSize, bold: true, color: textColor });
      }
      if (part.startsWith('`') && part.endsWith('`')) {
        return new TextRun({ text: part.slice(1, -1), font: _FONTS.code, size: fontSize - 2, color: _COLORS.inlineCode });
      }
      return new TextRun({ text: part, font: _FONTS.default, size: fontSize, color: textColor });
    });
  }

  function bullet(content, options = {}) {
    const bulletColor = _COLORS.bulletText || _COLORS.text;
    const children = parseInlineFormatting(content, _SIZES.body, bulletColor);
    return new Paragraph({
      numbering: { reference: "bullets", level: 0 }, spacing: options.spacing || {},
      children
    });
  }

  function numberedItem(number, content, options = {}) {
    const textColor = options.color || _COLORS.text;
    const children = [
      new TextRun({ text: `${number}. `, font: _FONTS.default, size: _SIZES.body, color: textColor }),
      ...parseInlineFormatting(content, _SIZES.body, textColor)
    ];
    return new Paragraph({
      indent: { left: 720, hanging: 360 },
      spacing: options.spacing || { before: 60, after: 60 },
      children
    });
  }

  function labelText(label, content = '') {
    const children = [
      new TextRun({ text: label, font: _FONTS.default, size: _SIZES.body, bold: true, color: _COLORS.primary })
    ];
    if (content) {
      children.push(new TextRun({ text: ' ' + content, font: _FONTS.default, size: _SIZES.body, color: _COLORS.text }));
    }
    return new Paragraph({
      spacing: { before: 150, after: 80 },
      children
    });
  }

  function note(content) {
    return new Paragraph({
      children: [new TextRun({ text: content, font: _FONTS.default, size: _SIZES.small, italics: true, color: _COLORS.textLight })]
    });
  }

  function infoBox(content) {
    const noBorder = { style: BorderStyle.NONE, size: 0, color: _COLORS.white };
    const leftBorder = { style: BorderStyle.SINGLE, size: 18, color: _COLORS.infoBoxBorder || _COLORS.primary };

    return new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      indent: { size: 0, type: WidthType.DXA },
      borders: { top: noBorder, bottom: noBorder, left: leftBorder, right: noBorder },
      rows: [
        new TableRow({
          children: [
            new TableCell({
              width: { size: 100, type: WidthType.PERCENTAGE },
              borders: { top: noBorder, bottom: noBorder, left: leftBorder, right: noBorder },
              shading: { fill: _COLORS.infoBox, type: ShadingType.CLEAR },
              margins: { top: 100, bottom: 100, left: 150, right: 150 },
              children: [
                new Paragraph({
                  spacing: { before: 0, after: 0 },
                  children: parseInlineFormatting(content, _SIZES.small, _COLORS.primary)
                })
              ]
            })
          ]
        })
      ]
    });
  }

  function warningBox(content) {
    const noBorder = { style: BorderStyle.NONE, size: 0, color: _COLORS.white };
    const leftBorder = { style: BorderStyle.SINGLE, size: 18, color: _COLORS.warningBoxBorder || _COLORS.accent };

    return new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      indent: { size: 0, type: WidthType.DXA },
      borders: { top: noBorder, bottom: noBorder, left: leftBorder, right: noBorder },
      rows: [
        new TableRow({
          children: [
            new TableCell({
              width: { size: 100, type: WidthType.PERCENTAGE },
              borders: { top: noBorder, bottom: noBorder, left: leftBorder, right: noBorder },
              shading: { fill: _COLORS.warningBox, type: ShadingType.CLEAR },
              margins: { top: 100, bottom: 100, left: 150, right: 150 },
              children: [
                new Paragraph({
                  spacing: { before: 0, after: 0 },
                  children: [
                    ...parseInlineFormatting(content, _SIZES.small, _COLORS.warningBoxText)
                  ]
                })
              ]
            })
          ]
        })
      ]
    });
  }

  function flowBox(contentLines) {
    const noBorder = { style: BorderStyle.NONE, size: 0, color: _COLORS.white };
    const leftBorder = { style: BorderStyle.SINGLE, size: 18, color: _COLORS.flowBoxBorder };

    const paragraphs = contentLines.map((line, idx) => {
      const isStepLine = /^\*\*Step \d|^Step \d/.test(line);
      const isBullet = line.startsWith('- ');
      const isNumbered = /^\d+\.\s/.test(line);

      const parseInline = (txt) => {
        const parts = txt.split(/(\*\*[^*]+\*\*|`[^`]+`)/);
        return parts.map(part => {
          if (part.startsWith('**') && part.endsWith('**')) {
            return new TextRun({ text: part.slice(2, -2), font: _FONTS.default, size: _SIZES.small, color: _COLORS.textDark, bold: true });
          }
          if (part.startsWith('`') && part.endsWith('`')) {
            return new TextRun({ text: part.slice(1, -1), font: _FONTS.code, size: _SIZES.code, color: _COLORS.inlineCode });
          }
          return new TextRun({ text: part, font: _FONTS.default, size: _SIZES.small, color: _COLORS.textLight });
        });
      };

      if (isBullet) {
        const bulletText = line.substring(2);
        const runs = parseInline(bulletText);
        return new Paragraph({
          spacing: { before: 40, after: 40 },
          indent: { left: 300 },
          children: [new TextRun({ text: "\u2022 ", font: _FONTS.default, size: _SIZES.small, color: _COLORS.flowBoxBorder }), ...runs]
        });
      } else if (isNumbered) {
        const match = line.match(/^(\d+)\.\s(.*)$/);
        const num = match[1];
        const numContent = match[2];
        const runs = parseInline(numContent);
        return new Paragraph({
          spacing: { before: 60, after: 40 },
          indent: { left: 100 },
          children: [new TextRun({ text: `${num}. `, font: _FONTS.default, size: _SIZES.small, color: _COLORS.flowBoxBorder, bold: true }), ...runs]
        });
      } else if (isStepLine) {
        const cleanLine = line.replace(/\*\*/g, '');
        return new Paragraph({
          spacing: { before: idx === 0 ? 0 : 120, after: 40 },
          children: [
            new TextRun({ text: "\u25B6 ", font: _FONTS.default, size: _SIZES.small, color: _COLORS.flowBoxBorder }),
            new TextRun({ text: cleanLine, font: _FONTS.default, size: _SIZES.small, color: _COLORS.text, bold: true })
          ]
        });
      } else {
        const runs = parseInline(line);
        return new Paragraph({
          spacing: { before: 40, after: 40 },
          children: runs
        });
      }
    });

    return new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      indent: { size: 0, type: WidthType.DXA },
      borders: { top: noBorder, bottom: noBorder, left: leftBorder, right: noBorder },
      rows: [
        new TableRow({
          children: [
            new TableCell({
              width: { size: 100, type: WidthType.PERCENTAGE },
              borders: { top: noBorder, bottom: noBorder, left: leftBorder, right: noBorder },
              shading: { fill: _COLORS.flowBoxBg, type: ShadingType.CLEAR },
              margins: { top: 120, bottom: 120, left: 180, right: 150 },
              children: paragraphs
            })
          ]
        })
      ]
    });
  }

  function pageBreak() {
    return new Paragraph({ children: [new PageBreak()] });
  }

  function spacer(before = 0) {
    return new Paragraph({ spacing: { before }, children: [] });
  }

  // ============================================================
  // Code blocks
  // ============================================================

  function createCodeBlock(lines) {
    const codeBorder = { style: BorderStyle.SINGLE, size: 12, color: _COLORS.codeBorder };
    const codeShading = { fill: _COLORS.codeBlock, type: ShadingType.CLEAR };
    const rows = lines.map((line, i) => new TableRow({
      children: [new TableCell({
        borders: {
          top: i === 0 ? codeBorder : { style: BorderStyle.NONE },
          bottom: i === lines.length - 1 ? codeBorder : { style: BorderStyle.NONE },
          left: codeBorder,
          right: codeBorder
        },
        shading: codeShading,
        margins: { top: 30, bottom: 30, left: 200, right: 200 },
        width: { size: _contentWidth, type: WidthType.DXA },
        children: [new Paragraph({
          children: [new TextRun({
            text: line || " ",
            font: _FONTS.code,
            size: _SIZES.code,
            color: _COLORS.text
          })]
        })]
      })]
    }));
    return new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      columnWidths: [_contentWidth],
      rows
    });
  }

  function createFlowBlock(lines) {
    const blockBorder = { style: BorderStyle.SINGLE, size: 6, color: _COLORS.flowBlockBorder };
    const blockShading = { fill: _COLORS.flowBlockBg, type: ShadingType.CLEAR };

    const paragraphs = lines.map(line => new Paragraph({
      spacing: { before: 0, after: 0, line: 300 },
      children: [new TextRun({
        text: line || " ",
        font: _FONTS.default,
        size: _SIZES.small,
        color: _COLORS.textDark,
        bold: true
      })]
    }));

    return new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      columnWidths: [_contentWidth],
      rows: [new TableRow({
        children: [new TableCell({
          borders: { top: blockBorder, bottom: blockBorder, left: blockBorder, right: blockBorder },
          shading: blockShading,
          margins: { top: 100, bottom: 100, left: 200, right: 200 },
          width: { size: _contentWidth, type: WidthType.DXA },
          children: paragraphs
        })]
      })]
    });
  }

  function createJsonBlock(lines) {
    const noBorder = { style: BorderStyle.NONE, size: 0, color: _COLORS.jsonBg };

    const paragraphs = lines.map(line => new Paragraph({
      spacing: { before: 0, after: 0, line: 260 },
      children: [new TextRun({
        text: line || " ",
        font: _FONTS.code,
        size: _SIZES.code,
        color: _COLORS.text
      })]
    }));

    return new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      columnWidths: [_contentWidth],
      rows: [new TableRow({
        children: [new TableCell({
          borders: { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder },
          shading: { fill: _COLORS.jsonBg, type: ShadingType.CLEAR },
          margins: { top: 100, bottom: 100, left: 200, right: 200 },
          width: { size: _contentWidth, type: WidthType.DXA },
          children: paragraphs
        })]
      })]
    });
  }

  // Syntax highlighting (dark theme)
  const _KEYWORDS = new Set([
    'public', 'private', 'protected', 'class', 'interface', 'fun', 'func', 'function',
    'val', 'var', 'let', 'const', 'return', 'if', 'else', 'when', 'switch', 'case',
    'for', 'while', 'do', 'break', 'continue', 'true', 'false', 'null', 'nil',
    'this', 'self', 'super', 'new', 'void', 'async', 'await', 'override', 'final',
    'static', 'extends', 'implements', 'import', 'package', 'guard', 'in', 'is', 'as',
    'try', 'catch', 'throw', 'throws', 'object', 'companion', 'data', 'sealed', 'enum'
  ]);

  function _tokenizeLine(line) {
    const tokens = [];
    let i = 0;

    while (i < line.length) {
      if (/\s/.test(line[i])) {
        let space = '';
        while (i < line.length && /\s/.test(line[i])) space += line[i++];
        tokens.push({ text: space, color: _SYNTAX.default });
        continue;
      }

      if (line.slice(i, i+2) === '//' || line.slice(i, i+2) === '/*' || (line[i] === '*' && (i === 0 || /\s/.test(line[i-1])))) {
        tokens.push({ text: line.slice(i), color: _SYNTAX.comment });
        break;
      }

      if (line[i] === '@') {
        let anno = '@';
        i++;
        while (i < line.length && /\w/.test(line[i])) anno += line[i++];
        tokens.push({ text: anno, color: _SYNTAX.annotation });
        continue;
      }

      if (line[i] === '"' || line[i] === "'") {
        const quote = line[i];
        let str = quote;
        i++;
        while (i < line.length && line[i] !== quote) {
          if (line[i] === '\\' && i + 1 < line.length) { str += line[i++]; }
          str += line[i++];
        }
        if (i < line.length) str += line[i++];
        tokens.push({ text: str, color: _SYNTAX.string });
        continue;
      }

      if (/\d/.test(line[i])) {
        let num = '';
        while (i < line.length && /[\d.]/.test(line[i])) num += line[i++];
        tokens.push({ text: num, color: _SYNTAX.number });
        continue;
      }

      if (/\w/.test(line[i])) {
        let word = '';
        while (i < line.length && /\w/.test(line[i])) word += line[i++];

        if (_KEYWORDS.has(word)) {
          tokens.push({ text: word, color: _SYNTAX.keyword });
        } else if (/^[A-Z]/.test(word)) {
          tokens.push({ text: word, color: _SYNTAX.type });
        } else {
          tokens.push({ text: word, color: _SYNTAX.default });
        }
        continue;
      }

      tokens.push({ text: line[i], color: _SYNTAX.default });
      i++;
    }

    return tokens;
  }

  function createSyntaxCodeBlock(lines) {
    const isLight = _code.mode === 'light';
    const bgColor = isLight ? _code.lightBg : _COLORS.codeDarkBg;
    const borderColor = isLight ? _code.lightBorder : _COLORS.codeDarkBorder;
    const borderWidth = _code.borderWidth != null ? _code.borderWidth : (isLight ? 1 : 8);
    const codeBorder = { style: BorderStyle.SINGLE, size: borderWidth, color: borderColor };
    const darkBg = { fill: bgColor, type: ShadingType.CLEAR };

    const paragraphs = lines.map(line => {
      const tokens = _tokenizeLine(line || " ");
      const runs = tokens.map(t => new TextRun({
        text: t.text,
        font: _FONTS.code,
        size: _SIZES.code,
        color: t.color
      }));
      return new Paragraph({
        spacing: { before: 0, after: 0, line: 276 },
        children: runs.length ? runs : [new TextRun({ text: " ", font: _FONTS.code, size: _SIZES.code })]
      });
    });

    return new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      columnWidths: [_contentWidth],
      rows: [new TableRow({
        children: [new TableCell({
          borders: { top: codeBorder, bottom: codeBorder, left: codeBorder, right: codeBorder },
          shading: darkBg,
          margins: { top: 150, bottom: 150, left: 200, right: 200 },
          width: { size: _contentWidth, type: WidthType.DXA },
          children: paragraphs
        })]
      })]
    });
  }

  // ============================================================
  // Tables
  // ============================================================

  function createSimpleTable(rows, labelWidth = 2500) {
    const valueWidth = 9360 - labelWidth;
    return new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      columnWidths: [labelWidth, valueWidth],
      rows: [
        new TableRow({ children: [_headerCell("\ud56d\ubaa9", labelWidth), _headerCell("\uc124\uba85", valueWidth)] }),
        ...rows.map((row, i) => new TableRow({
          children: [_bodyCell(row.label, labelWidth, i % 2 === 0), _bodyCell(row.value, valueWidth, i % 2 === 0)]
        }))
      ]
    });
  }

  function createTable(headers, widths, rows) {
    return new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      columnWidths: widths,
      rows: [
        new TableRow({ children: headers.map((h, i) => _headerCell(h, widths[i])) }),
        ...rows.map((row, ri) => new TableRow({
          children: row.map((cell, ci) => _bodyCell(cell, widths[ci], ri % 2 === 0))
        }))
      ]
    });
  }

  // ============================================================
  // Cover page
  // ============================================================

  function createCoverPage(title, subtitle, projectInfo, author, logoPath = null) {
    const elements = [];
    const _titleSize = _cover.titleSize || _SIZES.title;
    const _logoW = _cover.logoWidth;
    const _logoH = _cover.logoHeight;

    // 로고 삽입 헬퍼
    function _pushLogo(topSpacing, afterSpacing) {
      if (logoPath && fs.existsSync(logoPath)) {
        const imageBuffer = fs.readFileSync(logoPath);
        const ext = path.extname(logoPath).toLowerCase().replace('.', '');
        const imageType = ext === 'jpg' ? 'jpeg' : ext;
        elements.push(new Paragraph({ spacing: { before: topSpacing }, children: [] }));
        elements.push(new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 100, after: afterSpacing },
          children: [new ImageRun({ type: imageType, data: imageBuffer, transformation: { width: _logoW, height: _logoH } })]
        }));
      } else {
        elements.push(new Paragraph({ spacing: { before: topSpacing + 1000 }, children: [] }));
      }
    }

    if (_cover.style === 'centered') {
      // 원본 PDF 스타일: 로고 상단 → 제목 2줄 중앙 → 날짜+버전 하단
      _pushLogo(1200, 600);
      elements.push(new Paragraph({ spacing: { before: 2400 }, children: [] }));
      // title에 \n이 있으면 줄바꿈 분리
      const titleLines = title.split('\n');
      for (const line of titleLines) {
        elements.push(new Paragraph({
          alignment: AlignmentType.CENTER, spacing: { after: 200 },
          children: [new TextRun({ text: line, bold: true, size: _titleSize, font: _FONTS.default, color: _COLORS.text })]
        }));
      }
      if (subtitle) {
        elements.push(new Paragraph({
          alignment: AlignmentType.CENTER, spacing: { after: 200 },
          children: [new TextRun({ text: subtitle, bold: true, size: _titleSize, font: _FONTS.default, color: _COLORS.text })]
        }));
      }
      // 하단 날짜/버전 (projectInfo)
      elements.push(new Paragraph({ spacing: { before: 3000 }, children: [] }));
      for (const row of projectInfo) {
        elements.push(new Paragraph({
          alignment: AlignmentType.CENTER, spacing: { after: 100 },
          children: [new TextRun({ text: row.value, bold: true, font: _FONTS.default, size: _SIZES.body, color: _COLORS.text })]
        }));
      }
      elements.push(new Paragraph({ children: [new PageBreak()] }));
    } else {
      // 기존 default 레이아웃
      _pushLogo(2000, 800);
      elements.push(new Paragraph({
        alignment: AlignmentType.CENTER, spacing: { after: 400 },
        children: [new TextRun({ text: title, bold: true, size: _titleSize, font: _FONTS.default, color: _COLORS.secondary })]
      }));
      elements.push(new Paragraph({
        alignment: AlignmentType.CENTER, spacing: { after: 800 },
        children: [new TextRun({ text: subtitle, size: _SIZES.subtitle, font: _FONTS.default, color: _COLORS.textLight })]
      }));
      const metaText = projectInfo.map(row => `${row.label} ${row.value}`).join("  \u00B7  ");
      elements.push(
        new Paragraph({ spacing: { before: 800 }, children: [] }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: metaText, font: _FONTS.default, size: 18, color: _COLORS.textLight })]
        }),
        new Paragraph({ children: [new PageBreak()] })
      );
    }

    return elements;
  }

  // ============================================================
  // Document creation
  // ============================================================

  function createDocument(children, docInfo = null) {
    const rightTabPosition = _rightTab;

    const sectionProps = {
      properties: _pageSettings,
      children: children.flat()
    };

    if (docInfo) {
      const _hdrFont = _FONTS.header || _FONTS.default;
      const _hdrSize = _SIZES.headerFooter || 18;
      const _hdrColor = _COLORS.headerFont || _COLORS.headerFooter;
      const _ftrFont = _FONTS.footer || _FONTS.default;
      const _ftrColor = _COLORS.footerFont || _COLORS.headerFooter;
      const _headerLeftText = _header.text || docInfo.title;

      const headerParagraph = new Paragraph({
        tabStops: [{ type: TabStopType.RIGHT, position: rightTabPosition }],
        border: _header.border ? { bottom: { style: BorderStyle.SINGLE, size: 1, color: _hdrColor } } : undefined,
        children: [
          new TextRun({ text: _headerLeftText, font: _hdrFont, size: _hdrSize, color: _hdrColor }),
          ...(docInfo.version ? [
            new TextRun({ text: "\t" }),
            new TextRun({ text: docInfo.version, font: _hdrFont, size: _hdrSize, color: _hdrColor })
          ] : [])
        ]
      });

      sectionProps.headers = { default: new Header({ children: [headerParagraph] }) };
      sectionProps.footers = {
        default: new Footer({
          children: [
            new Paragraph({
              tabStops: [{ type: TabStopType.RIGHT, position: rightTabPosition }],
              children: [
                new TextRun({ text: docInfo.company || '', font: _ftrFont, size: _hdrSize, color: _ftrColor }),
                new TextRun({ text: "\t" }),
                new TextRun({ font: _ftrFont, size: _hdrSize, color: _ftrColor, children: [PageNumber.CURRENT] }),
                new TextRun({ text: " / ", font: _ftrFont, size: _hdrSize, color: _ftrColor }),
                new TextRun({ font: _ftrFont, size: _hdrSize, color: _ftrColor, children: [PageNumber.TOTAL_PAGES] })
              ]
            })
          ]
        })
      };
    }

    return new Document({
      features: { updateFields: true },
      styles: _docStyles,
      numbering: _numbering,
      sections: [sectionProps]
    });
  }

  async function saveDocument(doc, filepath) {
    const rawBuffer = await Packer.toBuffer(doc);
    const buffer = _applyDocSettings(rawBuffer);
    try {
      fs.writeFileSync(filepath, buffer);
    } catch (err) {
      if (err.code === 'EBUSY' && process.platform === 'win32') {
        const filename = path.basename(filepath);
        console.log(`[WARN] \ud30c\uc77c\uc774 \uc5f4\ub824 \uc788\uc74c: ${filename}`);
        console.log(`[INFO] \ud30c\uc77c\uc744 \uc7a1\uace0 \uc788\ub294 \ud504\ub85c\uc138\uc2a4\ub97c \uc885\ub8cc\ud569\ub2c8\ub2e4...`);
        const { execSync } = require('child_process');
        try {
          let killed = false;
          try {
            execSync(
              `powershell -Command "Get-Process | Where-Object { $_.MainWindowTitle -like '*${filename.replace('.docx','')}*' } | Stop-Process -Force"`,
              { timeout: 5000, stdio: 'pipe' }
            );
            killed = true;
          } catch (e) {
            try {
              execSync('taskkill /IM WINWORD.EXE /F', { timeout: 5000, stdio: 'pipe' });
              killed = true;
            } catch (e2) {}
          }
          if (killed) {
            const dir = path.dirname(filepath);
            const lockFile = path.join(dir, '~$' + filename.substring(2));
            try { if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile); } catch (_) {}
            for (let retry = 0; retry < 3; retry++) {
              await new Promise(resolve => setTimeout(resolve, 1000));
              try {
                fs.writeFileSync(filepath, buffer);
                break;
              } catch (retryErr) {
                if (retry === 2) throw retryErr;
              }
            }
          }
        } catch (killErr) {}
        if (!fs.existsSync(filepath) || fs.statSync(filepath).size === 0) {
          throw new Error(`\ud30c\uc77c\uc774 \uc7a0\uaca8 \uc788\uc5b4 \uc800\uc7a5\ud560 \uc218 \uc5c6\uc2b5\ub2c8\ub2e4: ${filepath}\n\ud30c\uc77c\uc744 \uc218\ub3d9\uc73c\ub85c \ub2eb\uace0 \ub2e4\uc2dc \uc2dc\ub3c4\ud558\uc138\uc694.`);
        }
      } else {
        throw err;
      }
    }
    console.log(`Document saved: ${filepath}`);
  }

  function _applyDocSettings(docxBuffer) {
    try {
      const AdmZip = require('adm-zip');
      const zip = new AdmZip(docxBuffer);
      const entry = zip.getEntry('word/settings.xml');
      if (!entry) return docxBuffer;
      let xml = zip.readAsText(entry);
      if (xml.includes('hideSpellingErrors')) return docxBuffer;
      xml = xml.replace(
        '</w:settings>',
        '  <w:hideSpellingErrors/>\n  <w:hideGrammaticalErrors/>\n</w:settings>'
      );
      zip.updateFile(entry, Buffer.from(xml, 'utf-8'));
      return zip.toBuffer();
    } catch (err) {
      return docxBuffer;
    }
  }

  function createImage(imagePath, width = 580, height = 450) {
    if (!fs.existsSync(imagePath)) {
      console.log(`Image not found: ${imagePath}`);
      return note(`[\uc774\ubbf8\uc9c0 \uc5c6\uc74c: ${path.basename(imagePath)}]`);
    }

    const imageBuffer = fs.readFileSync(imagePath);
    const ext = path.extname(imagePath).toLowerCase().replace('.', '');
    const imageType = ext === 'jpg' ? 'jpeg' : ext;

    return new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 200, after: 200 },
      children: [
        new ImageRun({
          type: imageType,
          data: imageBuffer,
          transformation: { width, height }
        })
      ]
    });
  }

  // ============================================================
  // Return public API
  // ============================================================

  return {
    h1, h2, h3, h4, text, bullet, numberedItem, note, labelText, infoBox, warningBox, flowBox, pageBreak, spacer,
    createCodeBlock, createFlowBlock, createJsonBlock, createSyntaxCodeBlock, createImage,
    createSimpleTable, createTable,
    createCoverPage,
    createDocument, saveDocument
  };
}

module.exports = createTemplate;
