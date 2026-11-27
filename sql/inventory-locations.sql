CREATE TABLE IF NOT EXISTS public.os_inventory_operating_stock (
  material_id uuid PRIMARY KEY REFERENCES public.materials(id),
  quantity numeric(16,3) CHECK (quantity >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.os_inventory_operating_stock ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.os_inventory_operating_stock FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.os_admin_inventory_operating_stock()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $$
BEGIN
  PERFORM private.os_inventory_check_admin();
  RETURN coalesce((
    SELECT jsonb_object_agg(s.material_id, s.quantity)
    FROM public.os_inventory_operating_stock s
    JOIN public.materials m ON m.id = s.material_id
    WHERE m.active AND m.stock_counted AND s.quantity BETWEEN 0 AND m.on_hand
  ), '{}'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.os_admin_set_operating_stock(
  p_material_id uuid, p_quantity numeric
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $$
DECLARE
  stock public.materials%ROWTYPE;
BEGIN
  PERFORM private.os_inventory_check_admin();
  SELECT * INTO stock FROM public.materials WHERE id = p_material_id FOR UPDATE;
  IF NOT FOUND OR NOT stock.active OR NOT stock.stock_counted
    OR stock.tracking_mode = 'equipment' THEN
    RAISE EXCEPTION 'Registra primero el stock total del consumible';
  END IF;
  IF p_quantity IS NULL OR NOT (p_quantity BETWEEN 0 AND stock.on_hand)
    OR p_quantity <> round(p_quantity,3)
    OR (stock.unit IN ('ud','botella','rollo','caja') AND p_quantity <> trunc(p_quantity)) THEN
    RAISE EXCEPTION 'Introduce una cantidad válida entre cero y el stock total';
  END IF;
  INSERT INTO public.os_inventory_operating_stock (material_id, quantity)
  VALUES (p_material_id,p_quantity)
  ON CONFLICT (material_id) DO UPDATE SET quantity=excluded.quantity, updated_at=now();
END;
$$;

REVOKE ALL ON FUNCTION public.os_admin_inventory_operating_stock() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.os_admin_set_operating_stock(uuid,numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.os_admin_inventory_operating_stock() TO authenticated;
GRANT EXECUTE ON FUNCTION public.os_admin_set_operating_stock(uuid,numeric) TO authenticated;

CREATE OR REPLACE FUNCTION private.os_update_operating_stock()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $$
BEGIN
  IF NEW.kind <> 'purchase' THEN
    UPDATE public.os_inventory_operating_stock
    SET quantity=CASE WHEN NEW.kind='session' AND quantity+NEW.quantity_change>=0
                      THEN quantity+NEW.quantity_change END, updated_at=now()
    WHERE material_id=NEW.material_id;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS os_update_operating_stock ON public.stock_movements;
CREATE TRIGGER os_update_operating_stock AFTER INSERT ON public.stock_movements
FOR EACH ROW EXECUTE FUNCTION private.os_update_operating_stock();
