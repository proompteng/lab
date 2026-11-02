export const GET = () =>
  new Response('User-agent: *\nDisallow: /\n', {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
    },
  })
