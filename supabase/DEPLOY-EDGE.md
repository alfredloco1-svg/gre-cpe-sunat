# Desplegar Edge Functions

Project ref: `psfqhpxyidvhgozlptdd`

## Funciones

| Función | Uso |
|---------|-----|
| `obtener-token` | Token GRE/CPE emisión, consulta validez, y SIRE (`tipo: sire`) |
| `sire-propuesta` | Descarga propuesta RCE (compras) / RVIE (ventas) en el servidor |

## CLI (recomendada)

```bash
# Login y vincular (una vez)
npx supabase login
npx supabase link --project-ref psfqhpxyidvhgozlptdd

# Desplegar ambas
npx supabase functions deploy obtener-token
npx supabase functions deploy sire-propuesta
```

Supabase inyecta `SUPABASE_URL`, `SUPABASE_ANON_KEY` y `SUPABASE_SERVICE_ROLE_KEY`. No hace falta configurarlas a mano.

## Body `obtener-token`

```json
{ "empresa_id": "uuid", "tipo": "emision" }
{ "empresa_id": "uuid", "tipo": "consulta" }
{ "empresa_id": "uuid", "tipo": "sire" }
```

## Body `sire-propuesta`

```json
{
  "empresa_id": "uuid",
  "periodo": "202608",
  "libro": "rce"
}
```

- `libro`: `"rce"` (compras / recibidos) o `"rvie"` (ventas / emitidos)
- Respuesta OK: `{ ok: true, total, items: [...], ticket, periodo, libro }`
- Si el archivo aún no está listo: HTTP 202 con `ticket` (reintentar en 1–2 min)

## Flujo del usuario

1. Empresa activa con RUC, Usuario SOL, Clave SOL, Client ID/Secret (alcance **MIGE RCE y RVIE – SIRE**).
2. Menú **SIRE Compras/Ventas** → elige Compras o Ventas + mes.
3. **Cargar propuesta del mes** → la app llama a `sire-propuesta`.
4. Tabla con comprobantes → **Ver** en el Visor → **Exportar CSV**.

## Seguridad

- JWT del usuario obligatorio.
- Solo lee empresas del usuario (RLS).
- Clave SOL y Client Secret no salen al navegador en estas llamadas.
- Nunca pongas `service_role` en el frontend.
