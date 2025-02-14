-- figures.lua
-- Copyright (C) 2020 by RStudio, PBC

-- extended figure features including fig-align, fig-env, etc.
function extendedFigures() 
  return {
    
    Para = function(el)
      local image = discoverFigure(el)
      if image and shouldHandleExtended(image) then
        if isHtmlOutput() then
          return htmlImageFigure(image)
        elseif isLatexOutput() then
          return latexImageFigure(image)
        end
      end
    end,
    
    Div = function(el)
      if isFigureDiv(el) and shouldHandleExtended(el) then
        if isLatexOutput() then
          return latexDivFigure(el)
        elseif isHtmlOutput() then
          return htmlDivFigure(el)
        elseif isDocxOutput() then
          return wpDivFigure(el)
        end
      end
    end
    
  }
end

local kFigExtended = "fig.extended"

function preventExtendedFigure(el)
  el.attr.attributes[kFigExtended] = "false"
end

function shouldHandleExtended(el)
  return el.attr.attributes[kFigExtended] ~= "false"
end
