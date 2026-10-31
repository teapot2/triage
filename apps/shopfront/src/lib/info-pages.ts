// The store's help and company pages, for the footer and each page's side
// navigation.

export const infoSections = [
  {
    title: "Help",
    links: [
      { label: "Shipping", href: "/shipping" },
      { label: "Returns", href: "/returns" },
      { label: "Care guide", href: "/care" },
      { label: "Contact us", href: "/contact" },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "Our makers", href: "/makers" },
      { label: "Journal", href: "/journal" },
      { label: "Wholesale", href: "/wholesale" },
    ],
  },
] as const;

export type InfoSection = (typeof infoSections)[number]["title"];
