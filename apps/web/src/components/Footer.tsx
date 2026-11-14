import { Link } from 'react-router-dom'
import { COMPANY } from '../legal/company'

/**
 * The footer under every page, including the 404 and the legal pages themselves.
 *
 * It carries three facts that a French visitor must be able to find from anywhere: who
 * publishes the site, and the three legal documents. The company line is a sentence rather
 * than a second address block, so the footer stays one band on a phone.
 *
 * The links live in a named navigation: the header already has one, and two unnamed
 * navigations would leave a screen reader with no way to tell them apart.
 */
export function Footer() {
  return (
    <footer className="site-footer">
      <p className="muted">
        {COMPANY.name} — {COMPANY.legalForm} au capital de {COMPANY.capital} —{' '}
        {COMPANY.address} — {COMPANY.rcs} — TVA {COMPANY.vat}
      </p>
      <nav aria-label="Liens légaux">
        <Link to="/mentions-legales">Mentions légales</Link>
        <Link to="/confidentialite">Politique de confidentialité</Link>
        <Link to="/cgu">CGU</Link>
      </nav>
    </footer>
  )
}
