param(
    [string]$DocxPath,
    [string]$OutDir,
    [string]$Label
)

Add-Type -AssemblyName System.Drawing

$word = New-Object -ComObject Word.Application
$word.Visible = $false

try {
    $doc = $word.Documents.Open($DocxPath)

    # Export each page as image using Word's built-in export
    # First save as PDF
    $tempPdf = Join-Path $OutDir "$Label.pdf"
    $doc.SaveAs2([ref]$tempPdf, [ref]17)

    # Then use Windows built-in to render
    # Alternative: export as XPS and render
    $tempXps = Join-Path $OutDir "$Label.xps"
    # wdFormatXPS = 18
    $doc.SaveAs2([ref]$tempXps, [ref]18)

    $doc.Close()
    Write-Host "XPS saved: $tempXps"
    Write-Host "PDF saved: $tempPdf"
} finally {
    $word.Quit()
    [System.Runtime.Interopservices.Marshal]::ReleaseComObject($word) | Out-Null
}
