// Browser clocks estimate their offset from several uncached samples.
export function GET(): Response {
  return Response.json(
    { serverNow: Date.now() },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
