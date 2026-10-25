import Image from 'next/image'

export function TengriMark() {
  return (
    <Image
      alt=""
      aria-hidden="true"
      src="/tengri/icons/fruit-pear.svg"
      width={20}
      height={20}
      className="h-5 w-5 shrink-0 brightness-0 invert"
      unoptimized
    />
  )
}
