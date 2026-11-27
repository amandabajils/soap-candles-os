# Guía de mantenimiento

## Arquitectura e integraciones

| Área | Componentes que debes contrastar en el entorno |
| --- | --- |
| Identidad | Supabase Auth, perfiles, permisos de administración y de instructoras, RLS. |
| Operaciones | `workshop_sessions`, `reservations`, `os_session_attendance`, informes de sesión y vistas de aforo. |
| Talleres | Triggers de bloqueo, asistencia, remuneración, consumo y costes al completar. |
| Shopify | Endpoint firmado de recepción, catálogo de pedidos en `os_shopify_order_snapshots`, `reservation_financials`, vistas de conciliación y función de recuperación financiera. |
| Cowlendar | Webhook firmado, `os_cowlendar_webhook_events`, `os_cowlendar_live_bookings` y conciliación por identificador de pedido y sesión. |
| Atrápalo | Referencias externas, bandejas de importación, cambios, exceso de aforo y financiera. El cron de evidencia financiera lee datos ya disponibles dentro de Supabase. |
| Holded | Funciones de documentos, contabilidad y movimientos, con llamadas programadas. Comprueba tanto Cron como el resultado de la API. |
| Alertas | Cron de salud, cierre semanal y Centro de alertas. Los datos operativos verificados disparan los cálculos. |

Para el esquema actual consulta catálogos de PostgreSQL, migraciones aplicadas, políticas RLS y definición de vistas y rutinas. Revisa `cron.job` y `cron.job_run_details` con proyecciones que omitan credenciales. Mantén en un entorno privado cualquier instantánea completa que pueda contener configuraciones o excepciones identificables.

## Criterios operativos

- Separa asistencia real, reservas, devoluciones, liquidaciones y tesorería. Usa el cobro real cuando haya descuentos o compensaciones.
- Trata Holded como fuente de gastos conciliados y distingue el flujo imputable del saldo de una cuenta compartida.
- Parte del inventario y las recetas vigentes. Comprueba si un recuento ya incluye una recepción antes de imputarla.
- Respeta las tarifas configuradas y las excepciones autorizadas. El cálculo de remuneraciones y el pago efectivo son operaciones distintas.
- Si una integración omite datos o no encuentra una correspondencia única, conserva el evento, registra la incidencia y revisa la fuente. Los mensajes antiguos deben respetar cancelaciones confirmadas posteriores.
- Mantén marrón claro y verde según el estilo existente. Conserva Inicio como entrada y el calendario compacto con ocupación. Los avisos operativos pertenecen al Centro de alertas.
- El cierre requiere entrada de datos reales por el equipo. Comprueba la cadena sesión, asistencia, facilitación, consumo, coste y remuneración antes de darlo por conciliado.

## Despliegue y resolución de incidencias

1. Compara la rama objetivo con el HTML y el runtime servidos. Comprueba por separado la versión de las Edge Functions y el estado de las migraciones.
2. Revisa el cambio en rama aislada, aplica SQL versionado y verifica permisos. Ensaya con datos sintéticos y después compara resultados en producción mediante lecturas.
3. Para un fallo de sincronización, localiza el último evento recibido, procesado y conciliado. Revisa estado HTTP y ejecución de Cron por separado. Conserva el cursor y usa claves únicas al reintentar.
4. Para un fallo del cierre, inspecciona las asistencias, la sesión y los triggers. Evita volver a ejecutar ajustes manuales antes de comprobar movimientos y marcas de conciliación.
5. Documenta la evidencia y el procedimiento de recuperación. Si un reemplazo falla, detén su programación y conserva o reanuda el flujo anterior. Cualquier corrección de datos debe basarse en el historial de cambios.

## Decisión y trabajo pendiente

Se eligió una recuperación determinista de Shopify mediante GraphQL y SQL. La función `shopify-financial-recovery` es una comprobación de solo lectura. El endpoint requiere un bearer de servidor y la adquisición de candidatos queda restringida a `service_role`. Usa la credencial de lectura de pedidos del OS. El resultado es agregado y está limitado a 40 candidatos por invocación de prueba.

Antes de habilitar escrituras, comprueba una lectura autenticada de la tienda por el servidor y compara pedidos de prueba elegibles y ambiguos. Implementa el consumo completo con paginación y un RPC idempotente que registre el origen de la API directa. El RPC legado registra como procedencia el conector. Separa la recuperación financiera de la ingesta de ventas y de sus cambios. Verifica un ciclo completo de alta, cambios, devoluciones y reintentos. Aplica las migraciones desde una sola revisión y verifica que dos procesos no registran la misma operación.

Para Atrápalo, confirma acceso de lectura de titularidad del negocio a los correos o a una API de partner. Usa una bandeja duradera, deduplicación por mensaje y localizador, orden temporal, cuarentena y comparación en paralelo. Completa el inventario privado de fuentes y adapta allí las excepciones verificadas. Confirma por separado la cobertura de la extranet y la captación desde correos de Cowlendar.
