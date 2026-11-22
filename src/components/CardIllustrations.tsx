import type { ReactNode } from 'react';
import type { Suit, TarotCard } from '../domain/types';

// Original vector art. Geometry is fixed and has no connection to the draw engine.
const GOLD = '#dfc28a';
const MUTED = '#8e7b66';
const Star = ({ x = 120, y = 155, size = 27 }: { x?: number; y?: number; size?: number }) => (
  <path
    d={`M ${x} ${y - size} L ${x + size * 0.24} ${y - size * 0.24} L ${x + size} ${y} L ${x + size * 0.24} ${y + size * 0.24} L ${x} ${y + size} L ${x - size * 0.24} ${y + size * 0.24} L ${x - size} ${y} L ${x - size * 0.24} ${y - size * 0.24} Z`}
  />
);

const Sun = ({ x = 120, y = 153, radius = 31 }: { x?: number; y?: number; radius?: number }) => (
  <g>
    <circle cx={x} cy={y} r={radius} />
    <circle cx={x} cy={y} r={radius - 6} strokeOpacity=".35" />
    {Array.from({ length: 16 }, (_, index) => {
      const angle = (index * Math.PI) / 8;
      return (
        <line
          key={index}
          x1={x + Math.cos(angle) * (radius + 7)}
          y1={y + Math.sin(angle) * (radius + 7)}
          x2={x + Math.cos(angle) * (radius + (index % 2 ? 14 : 23))}
          y2={y + Math.sin(angle) * (radius + (index % 2 ? 14 : 23))}
        />
      );
    })}
  </g>
);

const Moon = ({ x = 120, y = 150, radius = 36 }: { x?: number; y?: number; radius?: number }) => (
  <path
    d={`M ${x + radius * 0.44} ${y - radius * 0.9} A ${radius} ${radius} 0 1 0 ${x + radius * 0.44} ${y + radius * 0.9} A ${radius * 0.84} ${radius * 0.84} 0 0 1 ${x + radius * 0.44} ${y - radius * 0.9} Z`}
  />
);

const Leaf = ({ x, y, flip = false }: { x: number; y: number; flip?: boolean }) => (
  <path
    transform={`translate(${x} ${y})${flip ? ' scale(-1 1)' : ''}`}
    d="M0 0 C-19-2-23-16-22-24 C-7-22 1-13 0 0 M0 0 L-14-16"
  />
);

const Laurel = () => (
  <g strokeWidth="1.2" strokeOpacity=".65">
    <path d="M115 277 C60 251 39 203 49 144 M125 277 C180 251 201 203 191 144" />
    {[0, 1, 2, 3, 4].map((index) => (
      <g key={index}>
        <Leaf x={57 + index * index * 2.7} y={194 + index * 17} />
        <Leaf x={183 - index * index * 2.7} y={194 + index * 17} flip />
      </g>
    ))}
  </g>
);

const Crown = ({ y = 102 }: { y?: number }) => (
  <g>
    <path
      d={`M86 ${y} L92 ${y + 23} H148 L154 ${y} L135 ${y + 9} L120 ${y - 10} L105 ${y + 9} Z M94 ${y + 30} H146`}
    />
    {[86, 120, 154].map((x) => (
      <circle key={x} cx={x} cy={x === 120 ? y - 13 : y - 3} r="2" fill={GOLD} />
    ))}
  </g>
);

const Cup = () => (
  <g>
    <path d="M-17-18 H17 V-6 C17 7 9 13 0 13 C-9 13-17 7-17-6 Z M-17-12 H-24 C-29 4-16 8-11 7 M17-12 H24 C29 4 16 8 11 7 M0 13 V27 M-12 28 H12" />
    <path d="M-10-12 H10" strokeOpacity=".4" />
  </g>
);
const Wand = () => (
  <g>
    <path d="M-3 29 L0-29 L3 29 Z M0-7 C-17-9-17-23-14-25 C-4-23 1-16 0-7 M1 8 C18 3 19-10 16-13 C6-10 0-2 1 8" />
    <circle cx="0" cy="-34" r="2" fill={GOLD} />
  </g>
);
const Sword = () => (
  <g>
    <path d="M0-34 L7-22 L3 13 H-3 L-7-22 Z M-17 14 Q0 8 17 14 M0 15 V31 M-5 31 H5 M0-25 V7" />
    <circle cx="0" cy="35" r="3" />
  </g>
);
const Pentacle = () => (
  <g>
    <circle r="25" />
    <circle r="21" strokeOpacity=".4" />
    <path d="M0-17 L10 14 L-16-5 H16 L-10 14 Z" />
  </g>
);
const suitSymbols: Record<Suit, ReactNode> = {
  Wands: <Wand />,
  Cups: <Cup />,
  Swords: <Sword />,
  Pentacles: <Pentacle />,
};

const MajorSymbol = ({ rank }: { rank: number }) => {
  switch (rank) {
    case 0:
      return (
        <g>
          <Sun x={157} y={106} radius={12} />
          <path d="M48 230 L88 201 L122 231 L152 206 L192 230 M120 184 V137 M120 143 L99 162 M120 145 L143 157 M120 182 L102 210 M120 182 L141 204 M97 144 L143 113" />
          <circle cx="121" cy="125" r="10" />
          <path d="M139 117 Q166 116 153 139 Q136 139 139 117" />
          <Star x={66} y={150} size={8} />
        </g>
      );
    case 1:
      return (
        <g>
          <path d="M81 108 C63 84 111 84 120 102 C129 120 177 120 159 96 C146 79 127 95 120 102 C111 112 94 125 81 108 M73 219 H167 M84 219 V237 M156 219 V237 M120 137 V199 M120 155 L92 137 M120 155 L148 179 M92 137 V112 M148 178 V199" />
          <circle cx="120" cy="128" r="9" />
          <Star x={76} y={182} size={10} />
          <circle cx="162" cy="199" r="8" />
        </g>
      );
    case 2:
      return (
        <g>
          <path d="M60 230 V113 H82 V230 M158 230 V113 H180 V230 M55 107 H87 M153 107 H185 M86 230 Q120 157 154 230 M120 121 V179" />
          <Moon y={139} radius={27} />
          <path d="M97 205 Q120 196 143 205 V223 Q120 214 97 223 Z" />
          <Star x={120} y={88} size={9} />
        </g>
      );
    case 3:
      return (
        <g>
          <Crown y={91} />
          <circle cx="120" cy="166" r="35" />
          <path d="M120 201 V233 M104 219 H136" />
          <Laurel />
          <Star x={120} y={165} size={15} />
        </g>
      );
    case 4:
      return (
        <g>
          <Crown y={92} />
          <path d="M77 224 V144 H163 V224 M77 170 H62 V230 H178 V170 H163 M92 197 H148 V224 H92 Z M96 138 V125 M144 138 V125" />
          <path d="M113 145 H127 M120 138 V184 M114 184 H126" />
          <circle cx="120" cy="134" r="3" />
        </g>
      );
    case 5:
      return (
        <g>
          <path d="M120 91 V171 M101 111 H139 M94 130 H146 M85 151 H155 M99 196 L143 240 M141 196 L97 240 M135 232 L140 227 M102 228 L108 234" />
          <circle cx="91" cy="188" r="12" />
          <circle cx="149" cy="188" r="12" />
          <path d="M78 174 Q120 145 162 174" />
        </g>
      );
    case 6:
      return (
        <g>
          <Sun x={120} y={107} radius={16} />
          <path d="M120 175 C77 148 86 128 105 139 L120 153 L135 139 C154 128 163 148 120 175 Z M82 207 L120 181 L158 207 M82 207 V233 M158 207 V233" />
          <circle cx="82" cy="196" r="8" />
          <circle cx="158" cy="196" r="8" />
          <path d="M74 235 Q120 212 166 235" />
        </g>
      );
    case 7:
      return (
        <g>
          <path d="M72 126 L120 91 L168 126 M79 126 H161 V215 H79 Z M90 126 V164 M150 126 V164 M79 166 H161 M105 189 L120 174 L135 189 L120 204 Z" />
          <circle cx="88" cy="225" r="13" />
          <circle cx="152" cy="225" r="13" />
          <Star x={120} y={117} size={9} />
          <path d="M64 241 H176" />
        </g>
      );
    case 8:
      return (
        <g>
          <path d="M89 108 C68 83 111 84 120 102 C129 120 172 121 151 96 C138 81 128 95 120 102 C111 112 102 123 89 108" />
          <path d="M73 200 C56 151 78 133 120 132 C162 133 184 151 167 200 L145 228 H95 Z M86 172 L99 163 M154 172 L141 163 M110 192 L120 202 L130 192 Z M120 202 V217 M102 213 Q120 226 138 213" />
          <path d="M85 184 Q76 206 95 222 M155 184 Q164 206 145 222" />
        </g>
      );
    case 9:
      return (
        <g>
          <path d="M83 228 L101 146 Q120 112 139 146 L157 228 Z M100 163 L130 174 L154 151 M160 141 V236 M143 133 H177 V168 H143 Z M151 133 V122 H169 V133" />
          <Star x={160} y={150} size={9} />
          <path d="M67 241 L111 226 L172 241" />
        </g>
      );
    case 10:
      return (
        <g>
          <circle cx="120" cy="165" r="59" />
          <circle cx="120" cy="165" r="43" />
          <circle cx="120" cy="165" r="10" />
          {Array.from({ length: 8 }, (_, i) => (
            <path key={i} transform={`rotate(${i * 45} 120 165)`} d="M120 155 V106" />
          ))}
          <Star x={120} y={84} size={8} />
          <Star x={120} y={246} size={8} />
        </g>
      );
    case 11:
      return (
        <g>
          <path d="M120 107 V232 M94 232 H146 M75 137 H165 M75 137 L56 184 H94 Z M165 137 L146 184 H184 Z M56 184 Q75 204 94 184 M146 184 Q165 204 184 184" />
          <circle cx="120" cy="100" r="8" />
          <Star x={120} y={158} size={10} />
        </g>
      );
    case 12:
      return (
        <g>
          <path d="M66 100 H174 M79 100 V229 M161 100 V229 M120 100 V149 L140 169 L120 184 M120 149 L101 171 M120 149 V190 M120 176 L100 188 M120 176 L140 188" />
          <circle cx="120" cy="204" r="10" />
          <circle cx="120" cy="204" r="24" strokeOpacity=".45" />
          <Leaf x={77} y={127} />
          <Leaf x={164} y={143} flip />
        </g>
      );
    case 13:
      return (
        <g>
          <path d="M120 121 C86 121 86 160 99 173 L99 194 H141 V173 C154 160 154 121 120 121 Z M111 194 V184 M120 194 V181 M129 194 V184 M115 169 L120 158 L125 169 Z" />
          <circle cx="107" cy="151" r="7" />
          <circle cx="133" cy="151" r="7" />
          <path d="M85 226 L155 207 M85 207 L155 226" />
          <Sun x={120} y={90} radius={11} />
          <path d="M72 243 H168" />
        </g>
      );
    case 14:
      return (
        <g>
          <path d="M75 116 H113 V137 Q94 159 75 137 Z M94 147 V166 M83 166 H105 M127 190 H165 V211 Q146 233 127 211 Z M146 221 V240 M135 240 H157 M101 151 C101 180 145 165 145 190 M94 154 C94 184 137 178 137 190" />
          <path d="M68 230 L91 194 L113 230 Z" />
          <Star x={154} y={118} size={20} />
        </g>
      );
    case 15:
      return (
        <g>
          <path d="M87 119 L75 92 L107 112 M153 119 L165 92 L133 112 M84 127 Q120 103 156 127 L150 165 L120 189 L90 165 Z M101 142 L110 147 M139 142 L130 147 M111 169 H129 M120 189 V209 M84 226 Q120 190 156 226" />
          <circle cx="76" cy="232" r="13" />
          <circle cx="164" cy="232" r="13" />
          <Star x={120} y={92} size={8} />
        </g>
      );
    case 16:
      return (
        <g>
          <path d="M85 236 L95 141 H145 L155 236 Z M93 140 V124 H106 V136 H116 V124 H129 V136 H139 V124 H149 V140 M110 236 V207 H130 V236 M111 166 H129 V184 H111 Z M136 86 L111 116 H129 L106 150 M79 164 L65 187 L78 184 L69 202 M165 178 L181 197 L170 194 L178 211" />
          <path d="M64 242 H176" />
        </g>
      );
    case 17:
      return (
        <g>
          <Star x={120} y={144} size={47} />
          <Star x={68} y={103} size={8} />
          <Star x={173} y={113} size={10} />
          <Star x={67} y={192} size={9} />
          <Star x={177} y={188} size={8} />
          <path d="M71 221 Q95 204 120 221 T169 221 M65 236 Q94 219 120 236 T175 236" />
        </g>
      );
    case 18:
      return (
        <g>
          <Moon y={128} radius={34} />
          <path d="M58 231 V176 H82 V231 M158 231 V176 H182 V231 M54 172 H86 M154 172 H186 M115 250 C169 214 88 214 125 178 M49 240 Q70 224 92 240 M148 240 Q170 224 191 240" />
          <Star x={171} y={100} size={7} />
          <Star x={64} y={119} size={6} />
        </g>
      );
    case 19:
      return (
        <g>
          <Sun y={142} radius={39} />
          <path d="M60 228 Q120 198 180 228 M76 237 Q120 217 164 237" />
          <Leaf x={91} y={225} />
          <Leaf x={149} y={225} flip />
        </g>
      );
    case 20:
      return (
        <g>
          <path d="M81 124 L125 145 L158 115 L170 127 L137 157 L158 202 L146 214 L125 170 L95 191 L83 178 L113 157 L70 136 Z M157 109 L177 132 M76 130 L88 118 M104 237 Q120 216 136 237 M77 226 Q91 207 105 226 M135 226 Q149 207 163 226" />
          <Star x={120} y={88} size={9} />
          <path d="M60 208 L77 201 M174 161 L192 154" />
        </g>
      );
    case 21:
      return (
        <g>
          <ellipse cx="120" cy="163" rx="52" ry="80" />
          <ellipse cx="120" cy="163" rx="44" ry="70" strokeOpacity=".35" />
          <path d="M120 125 V176 L101 210 M120 176 L140 198 M120 146 L94 161 M120 146 L146 131 M90 151 L98 171 M142 121 L150 141" />
          <circle cx="120" cy="113" r="9" />
          <Star x={56} y={101} size={9} />
          <Star x={184} y={101} size={9} />
          <Star x={56} y={231} size={9} />
          <Star x={184} y={231} size={9} />
        </g>
      );
    default:
      return <Star />;
  }
};

const PipPattern = ({ card }: { card: TarotCard }) => {
  const suit = card.suit!;
  if (card.rank > 10)
    return (
      <g>
        <Crown y={94} />
        <g transform="translate(120 180) scale(1.6)">{suitSymbols[suit]}</g>
        <Laurel />
      </g>
    );
  if (card.rank === 1)
    return (
      <g>
        <circle cx="120" cy="163" r="66" strokeOpacity=".25" />
        <g transform="translate(120 164) scale(1.8)">{suitSymbols[suit]}</g>
        <Star x={120} y={76} size={9} />
        <Star x={120} y={254} size={9} />
      </g>
    );
  const count = card.rank;
  const rows = Math.ceil(count / 2);
  const positions = Array.from({ length: count }, (_, index) => {
    if (count % 2 && index === count - 1) return { x: 120, y: 165 };
    const row = Math.floor(index / 2);
    const pairRows = Math.floor(count / 2);
    return { x: index % 2 ? 160 : 80, y: pairRows === 1 ? 165 : 97 + row * (136 / (pairRows - 1)) };
  });
  const scale = rows > 4 ? 0.45 : rows > 3 ? 0.59 : rows > 2 ? 0.72 : 0.91;
  return (
    <g>
      {positions.map(({ x, y }, index) => (
        <g key={index} transform={`translate(${x} ${y}) scale(${scale})`}>
          {suitSymbols[suit]}
        </g>
      ))}
    </g>
  );
};

const backgrounds: Record<Suit | 'major', string> = {
  major: '#26233c',
  Wands: '#332635',
  Cups: '#203340',
  Swords: '#252d42',
  Pentacles: '#243631',
};

export const SymbolicCardArtwork = ({
  card,
  reversed = false,
}: {
  card: TarotCard;
  reversed?: boolean;
}) => (
  <svg
    viewBox="0 0 240 330"
    width="100%"
    height="100%"
    aria-hidden="true"
    focusable="false"
    xmlns="http://www.w3.org/2000/svg"
  >
    <rect width="240" height="330" rx="13" fill={backgrounds[card.suit ?? 'major']} />
    <g fill="none" stroke={GOLD} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="10" y="10" width="220" height="310" rx="8" strokeOpacity=".65" />
      <path
        d="M25 61 V27 H59 M181 27 H215 V61 M25 269 V303 H59 M181 303 H215 V269"
        strokeOpacity=".4"
      />
      <path d="M37 52 Q120 12 203 52 M37 278 Q120 318 203 278" stroke={MUTED} strokeWidth="1" />
      <g transform={reversed ? 'rotate(180 120 165)' : undefined}>
        {card.arcana === 'major' ? <MajorSymbol rank={card.rank} /> : <PipPattern card={card} />}
        <circle cx="120" cy="42" r="3" fill={GOLD} stroke="none" />
        <path d="M108 288 H132 M120 282 V294" strokeOpacity=".6" />
      </g>
    </g>
  </svg>
);

export const CardBackArtwork = () => (
  <svg
    viewBox="0 0 240 330"
    width="100%"
    height="100%"
    aria-hidden="true"
    focusable="false"
    xmlns="http://www.w3.org/2000/svg"
  >
    <rect width="240" height="330" rx="13" fill="#242139" />
    <g fill="none" stroke={GOLD} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="10" y="10" width="220" height="310" rx="8" strokeOpacity=".72" />
      <rect x="18" y="18" width="204" height="294" rx="4" strokeOpacity=".24" />
      <path
        d="M34 72 Q120 30 206 72 M34 258 Q120 300 206 258 M49 34 Q77 165 49 296 M191 34 Q163 165 191 296"
        strokeOpacity=".28"
      />
      <path d="M120 46 L197 165 L120 284 L43 165 Z" strokeOpacity=".34" />
      <circle cx="120" cy="165" r="61" strokeOpacity=".6" />
      <circle cx="120" cy="165" r="52" strokeOpacity=".24" />
      <path d="M74 165 Q120 119 166 165 Q120 211 74 165 Z" />
      <circle cx="120" cy="165" r="19" />
      <Star x={120} y={165} size={12} />
      <Moon x={120} y={73} radius={12} />
      <g transform="rotate(180 120 165)">
        <Moon x={120} y={73} radius={12} />
      </g>
      <Star x={54} y={80} size={5} />
      <Star x={186} y={80} size={5} />
      <Star x={54} y={250} size={5} />
      <Star x={186} y={250} size={5} />
      <path d="M120 94 V104 M120 226 V236 M49 165 H59 M181 165 H191" />
      {[32, 208].map((x) => [32, 298].map((y) => <Star key={`${x}-${y}`} x={x} y={y} size={5} />))}
      <g fill={GOLD} stroke="none" opacity=".55">
        <circle cx="87" cy="103" r="1.5" />
        <circle cx="153" cy="103" r="1.5" />
        <circle cx="87" cy="227" r="1.5" />
        <circle cx="153" cy="227" r="1.5" />
        <circle cx="38" cy="121" r="1.5" />
        <circle cx="202" cy="121" r="1.5" />
        <circle cx="38" cy="209" r="1.5" />
        <circle cx="202" cy="209" r="1.5" />
      </g>
    </g>
  </svg>
);
