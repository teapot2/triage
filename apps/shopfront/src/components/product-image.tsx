import Image from "next/image";
import { productPhotos } from "@/lib/product-photos";
import { cn } from "@/lib/utils";
import { ProductArt } from "./product-art";

// A product's picture: its generated photo when there is one
// (scripts/generate-product-photos.ts), else the drawn placeholder. Fills
// its container either way; the caller sets the shape. Decorative (empty
// alt), since the product's name is always shown next to it.
export function ProductImage({
  name,
  art,
  tint,
  sizes,
  preload,
  className,
}: {
  name: string;
  art: string;
  tint: string;
  // How wide the picture shows, for picking a file size; see next/image.
  sizes: string;
  // Above the fold on its page (the hero, a product's main photo).
  preload?: boolean;
  className?: string;
}) {
  const photo = productPhotos[name];
  if (!photo) return <ProductArt art={art} tint={tint} className={className} />;
  return (
    <div className="relative size-full">
      <Image src={photo} alt="" fill sizes={sizes} preload={preload} className={cn("object-cover", className)} />
    </div>
  );
}
