import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import { AccessPanel } from '@/components/tengri/access-panel'
import { startTengriSignIn, signOutTengri } from './auth-client'

function Fixture() {
  const [authenticated, setAuthenticated] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    void fetch('/fixture/session').then((response) => setAuthenticated(response.ok))
  }, [])
  return (
    <main>
      <h1>Isolated Tengri identity fixture</h1>
      {authenticated ? (
        <>
          <button
            type="button"
            onClick={() =>
              void signOutTengri()
                .then(() => setAuthenticated(false))
                .catch((cause) => setError(String(cause)))
            }
          >
            Sign out
          </button>
          <AccessPanel />
        </>
      ) : (
        <button type="button" onClick={() => void startTengriSignIn().catch((cause) => setError(String(cause)))}>
          Sign in with GitHub
        </button>
      )}
      {error ? <p role="alert">{error}</p> : null}
    </main>
  )
}
const element = document.getElementById('root')
if (!element) throw new Error('Fixture root is missing')
createRoot(element).render(<Fixture />)
