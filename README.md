# Soap & Candles OS

Aplicación interna para calendario, reservas, talleres, inventario, finanzas y alertas. El frontend se sirve en [Render](https://soap-candles-os.onrender.com/) y utiliza Supabase para autenticación, PostgreSQL y funciones de servidor.

- `index.html` contiene la entrada y parte de la interfaz.
- `os-runtime.js` contiene el runtime publicado junto a la entrada.
- `sql/` contiene scripts versionados de cambios concretos. El esquema completo se mantiene en Supabase.
- `supabase/functions/` contiene las funciones versionadas en este repositorio. Hay otras funciones desplegadas que deben compararse con el proyecto antes de intervenir.
- [Guía de mantenimiento](docs/maintenance.md) e [instrucciones para Claude](CLAUDE.md).

Sirve el directorio con un servidor HTTP local para revisar la carga estática. La configuración del frontend puede apuntar a producción. Para probar escrituras usa un proyecto separado con datos sintéticos.
