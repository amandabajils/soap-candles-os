-- Start forward valuation from stock whose origin and cost are documented.
INSERT INTO public.material_inventory_balances
  (material_id, quantity_base, inventory_value, valuation_status)
SELECT m.id, m.on_hand, m.on_hand * c.cost, 'validated'
FROM public.materials m
CROSS JOIN LATERAL (
  SELECT CASE WHEN m.name = 'Mantel de papel A3' THEN 0
    ELSE (SELECT p.net_total / p.quantity_base
          FROM public.material_purchase_costs p
          WHERE p.material_id = m.id AND p.status IN ('verified', 'received')
          ORDER BY p.created_at DESC, p.id LIMIT 1)
    END AS cost
) c
WHERE m.active AND m.stock_counted AND c.cost IS NOT NULL
  AND (m.name IN ('Glicerina blanca', 'Tarro de cristal Winter Shore 170 ml', 'Mantel de papel A3')
       OR (m.name LIKE 'Aroma vela · %' AND m.on_hand = 1000))
ON CONFLICT (material_id) DO NOTHING;

CREATE OR REPLACE FUNCTION private.os_snapshot_session_material_cost()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $$
DECLARE
  balance public.material_inventory_balances%ROWTYPE;
  purchase public.material_purchase_costs%ROWTYPE;
  cost numeric;
  next_quantity numeric;
  next_value numeric;
  change_value numeric;
  entry_id uuid;
  entry_status text := 'pending_valuation';
  entry_kind text;
BEGIN
  SELECT * INTO balance FROM public.material_inventory_balances
  WHERE material_id = NEW.material_id FOR UPDATE;

  IF NEW.kind = 'purchase' THEN
    SELECT p.* INTO purchase
    FROM public.material_purchase_costs p
    JOIN public.os_expense_inventory_links l ON l.id = p.expense_inventory_link_id
    WHERE p.material_id = NEW.material_id AND p.quantity_base = NEW.quantity_change
      AND p.status IN ('verified', 'received')
      AND (l.stock_movement_id = NEW.id OR NEW.note =
        'Recepción confirmada de gasto ' || l.expense_id || ' · vínculo ' || l.id)
      AND (SELECT count(*) FROM public.material_purchase_costs x
           WHERE x.expense_inventory_link_id = l.id AND x.status IN ('verified', 'received')) = 1;
  END IF;

  entry_kind := CASE WHEN NEW.kind = 'session' THEN 'consumption' ELSE NEW.kind END;
  next_quantity := balance.quantity_base + NEW.quantity_change;
  IF next_quantity < 0 THEN
    next_quantity := NULL;
  END IF;

  IF balance.valuation_status = 'validated' AND next_quantity IS NOT NULL THEN
    IF NEW.kind = 'purchase' THEN
      cost := purchase.net_total / purchase.quantity_base;
    ELSIF NEW.kind = 'session' OR NEW.quantity_change < 0 THEN
      cost := balance.weighted_average_cost;
    END IF;

    IF cost IS NOT NULL THEN
      change_value := CASE WHEN next_quantity = 0 THEN -balance.inventory_value
                           ELSE NEW.quantity_change * cost END;
      next_value := balance.inventory_value + change_value;
      entry_status := 'validated';
    END IF;
  END IF;

  IF balance.material_id IS NOT NULL THEN
    UPDATE public.material_inventory_balances
    SET quantity_base = next_quantity, inventory_value = next_value,
        valuation_status = entry_status, updated_at = now()
    WHERE material_id = NEW.material_id;
  END IF;

  INSERT INTO public.material_valuation_entries
    (material_id, stock_movement_id, purchase_cost_id, event_key, entry_kind,
     quantity_change, value_change, unit_cost_applied, quantity_after, value_after,
     valuation_status, occurred_at)
  VALUES (NEW.material_id, NEW.id, purchase.id, 'movement:' || NEW.id, entry_kind,
          NEW.quantity_change, change_value, cost, next_quantity, next_value,
          entry_status, NEW.recorded_at)
  RETURNING id INTO entry_id;

  IF NEW.kind = 'session' AND NEW.session_id IS NOT NULL AND NEW.quantity_change < 0 THEN
    IF cost IS NULL THEN
      SELECT m.unit_cost INTO cost FROM public.materials m WHERE m.id = NEW.material_id;
    END IF;
    INSERT INTO public.session_material_costs
      (session_id, material_id, valuation_entry_id, quantity_consumed,
       unit_cost_applied, total_cost, status)
    VALUES (NEW.session_id, NEW.material_id, entry_id, -NEW.quantity_change, cost,
      coalesce(-change_value, -NEW.quantity_change * cost),
      CASE WHEN entry_status = 'validated' THEN 'validated'
           WHEN cost IS NOT NULL THEN 'estimated' ELSE 'pending_valuation' END);
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.os_admin_inventory_valuation()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $$
BEGIN
  PERFORM private.os_inventory_check_admin();
  RETURN (
    SELECT jsonb_build_object(
      'validated_value', coalesce(sum(b.inventory_value) FILTER (WHERE b.valuation_status = 'validated'), 0),
      'validated_materials', count(*) FILTER (WHERE b.valuation_status = 'validated'),
      'pending_materials', count(*) FILTER (WHERE coalesce(b.valuation_status, 'pending_valuation') <> 'validated')
    )
    FROM public.materials m
    LEFT JOIN public.material_inventory_balances b ON b.material_id = m.id
    WHERE m.active AND m.tracking_mode <> 'equipment'
  );
END;
$$;
REVOKE ALL ON FUNCTION public.os_admin_inventory_valuation() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.os_admin_inventory_valuation() TO authenticated;
