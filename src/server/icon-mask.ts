/**
 * Pi Pocket's π as coverage (0 to 255), 272 × 270 pixels at 512-pixel scale, from the origin (120, 110) of `web/icon.svg`'s
 * 512 × 512 drawing: the red channel of `web/icon-512.png` between the card's color and the π's, deflated. Georgia draws
 * it in the SVG; the server has no fonts or rasterizer, so it composites this instead.
 */
export const PI_MASK = {
    x: 120,
    y: 110,
    width: 272,
    height: 270,
    deflated: [
        "eNrtnW9oVWUcgN/rRq7NItPVPhQGEuYk1x/ErEFosRrkUNnQEqYoDSqyqLHRPrRhWImGa42GmMJIKRuC/5hlKsncHKJYQn1Y",
        "0R8Mpqw1pm0pa7tFlHt/955zt3MceN/ze56vh/PyPg/b5b3nvOceYwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABgAom98+6NpjCdeuTGbzivplOPAnoInqaHYA09BDX0EDTSQ7CHHoKT9BD8TA+x",
        "PL1CD5tpcXrY3G9PrCTpcKF9+NdxjnnJ0/qIE1/niqwZX8xMOrzMNjqroMdqa8bvJR9+wTY6rKDHG9aMC5IP19lGuxT0aBid",
        "8BmPwx/aRvUKerSMTnjdWKvXGgU92q/N92qux+ETtlGFgh4/XpvvHq/D39tGSxX0GEyx+PiHftuoMPo9pqZafBiTJYxmRb/H",
        "nFSLD2NmCKPbo9/jyVSLD2Pm2UJDk6LfozzV4sOYxbbQBRP9HtWpFh/GrLWFzinoUZ9q8ZFwsfmYgh67Uy0+jHnfFtqtoEdb",
        "qsWHMZ/YQo0Keqyt/peqTO/DR22hOgU9xuBbW+hFevxmC5Wp75E5bAs9rr5HnhDKV9/jASGUq77HU7bPcIb6HuW2T49R36PS",
        "9vmOHptsn+P0aLZ9Wujxue3TRI+zts96enTbPi+r7xEbsn1WqO8xXfg8ob5HvvCZq77HQuGTp77HCltnJFN9j1dsnT6jvscG",
        "W6eLHh/ZOu30OGDr7KXHKVtnGz3E1vYN9BgMuak6oj1uFTor1fe4V+gUqe/xmNB5UH0PsZc/fpf6HmIvfzxLfQ+xl/+SUd9D",
        "7OX/gR5iL38nPcRe/gP06LJtdtBD7OXfqL6H3Mtfqb6H3Mu/Sn0PsZc/Xqy+xzPCZp76HmIvf/we9T3kD8fkqO9Rb8sMGvU9",
        "xF7+X+hxzJY5TQ+xl/8QPXpsmWb1PbJGbJnN6nvIq+vV6nssEjJr1PdYJWQWq+8hl6fz1fdoCv31JZo9WoVMtvoe39gul436",
        "Hr+HvfsSzR45wqVDfY/7hMs+9T1KhMtW9T2qhMtb6nvsiId79iWqPTqEy3LtPWJ9wmWh9h4z4+Ee3Y9qj1LpMk17D/Fow/h/",
        "eSyyPQ4JlW6jvEeG/Dj9WnsPeW8//oX2HpVSZedE9DgamY+PYHcb/Hp0uJtjyp9S5fWJ6HHO3R5lCSorg53e59njJ3d77EpQ",
        "WRTs9AuePXrc/Xe5nKAyK9j55z17jNziao/nE1VuC3Z+l/drPOa72qMzQWTgOs8Pc88zfRdjQa+uJzy3O8oHjvbYmyjSFnCA",
        "7d49zseczDFnJFGkJeAIdT7vAVrgZI/WJI+GgCM869OjwcUcS5I9Ai5PzcM+PQbudC9Hjsf715YGHCN7yCfITvd6bPXQmBt0",
        "kFN+bxKrcC3HMi+LKUFH2eLXY7jUrRx393pIdAceptj3VXNDNfJXVKeWpfOfzM2ef+jtgce5qd//5Xsni/6/OJ1bsrHjr/jB",
        "9M0R+9TToDn4SB+neh3hxYNN6zdv/+q/b8Fp3ONN7/nXBh+pcPwva0zfHs+NeM+4PMRYZ9zvUey3ang0xGClzvdYMOA34zvC",
        "fBSdcLzH7F7fj79Q4z101e0eL/lO+HC4Aaui2mNLuAEnje9F5X8sd63H6pAjTj4yjhynZxvXeoSecXbLWDX612UY13r0hr/K",
        "F6sdSlVjcNP09F2b+vZovZ5RCzp9a/S+nWf0ESs+7nlvqq0ixyhlZk37FRGjb/9rM4xqJj9SXrvts/1ftjQ3Vi7JzzAAAAAA",
        "AAAAAAAAAAAAAJHib9UD6DI=",
    ].join(""),
};
