import { videoTranscriptAudits } from '@/src/data/olden/video-guides'

export function VideoTranscriptAuditTable() {
  return (
    <div className="not-prose overflow-x-auto rounded-lg border border-fd-border bg-fd-card">
      <table className="min-w-[920px] text-left text-sm">
        <thead className="bg-fd-muted/40 text-fd-foreground">
          <tr>
            <th className="px-3 py-2 font-semibold">Guide</th>
            <th className="px-3 py-2 font-semibold">Focus</th>
            <th className="px-3 py-2 font-semibold">Transcript status</th>
            <th className="px-3 py-2 font-semibold">Safe gameplay takeaway</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-fd-border text-fd-muted-foreground">
          {videoTranscriptAudits.map((video) => (
            <tr key={video.id}>
              <td className="max-w-[320px] px-3 py-2">
                <a className="font-medium text-fd-foreground underline underline-offset-2" href={video.url}>
                  {video.title}
                </a>
                <br />
                {video.channel} - {video.duration}
              </td>
              <td className="px-3 py-2 capitalize">{video.focus.replace('-', ' ')}</td>
              <td className="px-3 py-2">Blocked by YouTube bot-check during automated caption fetch.</td>
              <td className="max-w-[360px] px-3 py-2">{video.gameplayTakeaway}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
