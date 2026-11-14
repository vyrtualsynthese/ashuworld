/**
 * The company facts every legal page repeats.
 *
 * One copy on purpose: the mentions légales, the privacy notice, the footer and the
 * repository's legal documents must not drift apart. The address is the company's, not the
 * machine's; the host is the publisher, because the service is self-hosted.
 */
export const COMPANY = {
  name: 'ASHU DEV',
  legalForm: 'SARL (société à responsabilité limitée)',
  capital: '1 000 €',
  address: '14 rue Bausset, 75015 Paris, France',
  siren: '898 442 538',
  siret: '898 442 538 00010',
  rcs: 'RCS Paris 898 442 538',
  vat: 'FR 72 898 442 538',
  publicationDirector: 'Valentin Ronteix',
  email: 'info@ashudev.com',
  host: 'ASHU DEV (auto-hébergement sur infrastructure privée)',
} as const
