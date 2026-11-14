import type { LegalDocument } from '../legal/content'

/**
 * One legal document, rendered from the content module.
 *
 * The title and the description are React 19 document metadata: writing them as elements
 * lets React hoist them into the document head, so a page keeps its own title without a
 * side effect or a third-party head manager.
 *
 * The date is derived from the ISO `updated` field rather than typed a second time, so the
 * visible date cannot disagree with the version the visitor accepted.
 */
export function LegalPage({ document }: { document: LegalDocument }) {
  const updated = new Intl.DateTimeFormat('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${document.updated}T00:00:00Z`))

  return (
    <main className="page legal">
      <title>{document.title}</title>
      <meta name="description" content={document.description} />
      <h1>{document.title}</h1>
      <p className="muted legal-meta">
        Version {document.version} — mise à jour le {updated}
      </p>

      {document.sections.map((section) => (
        <section key={section.heading}>
          <h2>{section.heading}</h2>
          {section.paragraphs.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
          {section.list !== undefined && (
            <ul>
              {section.list.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </main>
  )
}
