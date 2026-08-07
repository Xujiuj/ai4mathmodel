'use strict';

function defaultLatexTemplate(competition = 'china') {
  if (competition === 'american') return `% Default template for MCM/ICM-style competitions.
\\documentclass[12pt,letterpaper]{article}
\\usepackage{amsmath,amssymb,booktabs,graphicx,geometry,ctex}
\\IfFileExists{simsun.ttf}{
  \\setmainfont{simsun.ttf}
  \\setsansfont{simhei.ttf}
  \\setmonofont{simkai.ttf}
  \\setCJKmainfont{simsun.ttf}
  \\setCJKsansfont{simhei.ttf}
  \\setCJKmonofont{simkai.ttf}
}{}
\\geometry{letterpaper,margin=1in}
\\title{MCM/ICM Mathematical Modeling Report}
\\author{}
\\date{}
\\begin{document}
\\section*{Summary Sheet}
State the problem, approach, principal numerical results, and recommendations in a self-contained summary.
\\newpage
\\maketitle
\\begin{abstract}
Summarize the problem, method, principal numerical findings, and limitations.
\\end{abstract}
\\section{Problem Restatement}
Describe the modeling task and the required outputs.
\\section{Assumptions and Notation}
State assumptions, variables, units, and constraints.
\\section{Model and Method}
Define the model and explain the solution method.
\\section{Results and Validation}
Report reproducible results and validation checks.
\\section{Sensitivity and Robustness}
Discuss how conclusions change under alternative assumptions.
\\section{Conclusions}
Summarize the answer and practical implications.
\\begin{thebibliography}{9}
\\bibitem{template} Replace this placeholder with a cited source.
\\end{thebibliography}
\\end{document}
`;

  return `% Default template for Chinese mathematical-modeling competitions.
\\documentclass[12pt,a4paper]{article}
\\usepackage{amsmath,amssymb,booktabs,graphicx,geometry,ctex}
\\IfFileExists{simsun.ttf}{
  \\setmainfont{simsun.ttf}
  \\setsansfont{simhei.ttf}
  \\setmonofont{simkai.ttf}
  \\setCJKmainfont{simsun.ttf}
  \\setCJKsansfont{simhei.ttf}
  \\setCJKmonofont{simkai.ttf}
}{}
\\geometry{a4paper,left=2.5cm,right=2.5cm,top=2.5cm,bottom=2.5cm}
\\title{Chinese Mathematical Modeling Competition Report}
\\author{}
\\date{}
\\begin{document}
\\maketitle
\\begin{abstract}
Summarize the problem, methods, principal numerical results, validation, and conclusions.
\\end{abstract}
\\noindent\\textbf{Keywords:} mathematical modeling; optimization; validation
\\section{Problem Restatement}
Restate every question and required output without copying the original statement verbatim.
\\section{Assumptions and Notation}
State assumptions, variables, units, constraints, and a symbol table.
\\section{Model Construction}
Define the model and justify the selected methods.
\\section{Solution and Results}
Report reproducible calculations, figures, tables, and numerical conclusions.
\\section{Sensitivity and Robustness}
Test parameter sensitivity, uncertainty, and robustness.
\\section{Model Evaluation}
Discuss strengths, limitations, and possible improvements.
\\section{Conclusions}
Answer each question directly and summarize practical implications.
\\begin{thebibliography}{9}
\\bibitem{template} Replace this placeholder with a cited source.
\\end{thebibliography}
\\end{document}
`;
}

module.exports = { defaultLatexTemplate };
