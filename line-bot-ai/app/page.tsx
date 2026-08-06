/**
 * Placeholder so the deployment root returns something intentional. All real
 * traffic goes to POST /api/line-webhook.
 */
export default function Home() {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem' }}>
      <h1>A&amp;W BRAND LINE Bot</h1>
      <p>
        Webhook endpoint: <code>POST /api/line-webhook</code>
      </p>
    </main>
  );
}
