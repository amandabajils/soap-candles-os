ALTER TABLE public.os_expense_inventory_links
  DROP CONSTRAINT os_expense_inventory_links_receipt_status_check,
  ADD CONSTRAINT os_expense_inventory_links_receipt_status_check
    CHECK (receipt_status IN ('not_verified','received','partial','historical'));

-- Purchases from before the physical opening count stay linked for documentary review.
UPDATE public.os_expense_inventory_links l
SET receipt_status = 'historical'
FROM public.os_expenses e
WHERE l.expense_id=e.id AND l.receipt_status='not_verified'
  AND l.stock_movement_id IS NULL AND e.invoice_date<'2026-11-19'
  AND l.source_description LIKE 'Excel octubre:%'
  AND e.document_reference IN ('ES622081ABEI','ES61ZH6MABEI','ES6243QXABEI',
    'ES623IMNABEI','GL2026/000867','ES61WYNCABEI');

-- Reuse the existing receipt and monthly readiness definitions.
DO $migration$
DECLARE
  receipt_definition text := pg_get_functiondef('public.os_confirm_expense_receipt(uuid)'::regprocedure);
  readiness_definition text := pg_get_viewdef('public.os_expense_monthly_readiness'::regclass);
  receipt_guard text := 'if not found then raise exception ''Vínculo de compra no encontrado''; end if;';
  readiness_filter text := 'l.receipt_status <> ''received''::text';
BEGIN
  IF strpos(receipt_definition, receipt_guard)=0 OR strpos(readiness_definition, readiness_filter)=0 THEN
    RAISE EXCEPTION 'Unexpected receipt or readiness definition';
  END IF;
  EXECUTE replace(receipt_definition, receipt_guard, receipt_guard || E'\n'
    || ' if l.receipt_status = ''historical'' then raise exception ''Compra anterior al recuento de apertura''; end if;');
  EXECUTE 'CREATE OR REPLACE VIEW public.os_expense_monthly_readiness AS '
    || replace(readiness_definition, readiness_filter,
      'l.receipt_status IN (''not_verified'', ''partial'')');
END;
$migration$;
