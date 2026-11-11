-- Extend the existing source registry; no historical data rewrite.
ALTER TABLE document_sources DROP CONSTRAINT document_sources_source_format_check;
ALTER TABLE document_sources ADD CONSTRAINT document_sources_source_format_check
 CHECK (source_format IN ('txt','md','csv','docx','xlsx','pptx','pdf','doc','xls','ppt','zip'));
