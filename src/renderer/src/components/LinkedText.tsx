import React from 'react'
import { splitLinks } from '../lib/links'

function Link({ url }: { url: string }): React.JSX.Element {
  return <a href={url} target="_blank" rel="noopener noreferrer" onClick={(event) => event.stopPropagation()} style={{ color: '#60a5fa', textDecoration: 'underline', overflowWrap: 'anywhere' }}>{url}</a>
}

export function LinkedText({ text }: { text: string }): React.JSX.Element {
  return <>{splitLinks(text).map((part, index) => part.url ? <Link key={index} url={part.url} /> : <React.Fragment key={index}>{part.text}</React.Fragment>)}</>
}

/** Editable text stays unchanged; detected links are available below the input. */
export function TextLinks({ text }: { text: string }): React.JSX.Element | null {
  const urls = [...new Set(splitLinks(text).flatMap((part) => part.url ? [part.url] : []))]
  if (!urls.length) return null
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: '0.8rem' }} aria-label="本文のリンク">{urls.map((url) => <Link key={url} url={url} />)}</div>
}
