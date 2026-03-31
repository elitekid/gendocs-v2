Dim args
Set args = WScript.Arguments
If args.Count < 2 Then
    WScript.Echo "Usage: cscript docx2pdf.vbs input.docx output.pdf"
    WScript.Quit 1
End If

Dim word
Set word = CreateObject("Word.Application")
word.Visible = False
word.DisplayAlerts = 0

Dim doc
Set doc = word.Documents.Open(args(0), False, True)
doc.SaveAs2 args(1), 17
doc.Close False
word.Quit
WScript.Echo "OK"
