package scan

import (
	"encoding/binary"
	"fmt"
	"net"
	"strconv"
	"strings"
)

// ExpandTargets convierte lo que escribe el operador en una lista de IP:
//   - "10.0.6.26"        una IP
//   - "10.0.6.1-50"      rango en el ultimo octeto
//   - "10.0.6.1-10.0.7.20" rango completo
//   - "10.0.6.0/24"      red (sin la direccion de red ni la de broadcast)
//
// Corta en max para que un /16 escrito por error no barra 65 mil equipos de un hospital.
func ExpandTargets(targets []string, max int) ([]string, error) {
	var out []string
	seen := map[string]bool{}
	add := func(ip uint32) bool {
		s := intToIP(ip)
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
		return len(out) < max
	}

	for _, raw := range targets {
		t := strings.TrimSpace(raw)
		if t == "" {
			continue
		}
		switch {
		case strings.Contains(t, "/"):
			_, network, err := net.ParseCIDR(t)
			if err != nil {
				return nil, fmt.Errorf("%q no es una red valida (ej. 10.0.6.0/24)", t)
			}
			ones, bits := network.Mask.Size()
			if bits != 32 || ones < 16 {
				return nil, fmt.Errorf("%q: la red debe ser IPv4 y de /16 a /32", t)
			}
			first := ipToInt(network.IP)
			size := uint32(1) << uint(32-ones)
			start, end := first, first+size-1
			if size > 2 {
				start, end = first+1, first+size-2
			}
			for ip := start; ip <= end; ip++ {
				if !add(ip) {
					return out, nil
				}
			}
		case strings.Contains(t, "-"):
			parts := strings.SplitN(t, "-", 2)
			a := net.ParseIP(strings.TrimSpace(parts[0])).To4()
			endStr := strings.TrimSpace(parts[1])
			if !strings.Contains(endStr, ".") && a != nil {
				n, err := strconv.Atoi(endStr)
				if err != nil || n < 0 || n > 255 {
					return nil, fmt.Errorf("%q no es un rango valido (ej. 10.0.6.1-50)", t)
				}
				endStr = fmt.Sprintf("%d.%d.%d.%d", a[0], a[1], a[2], n)
			}
			b := net.ParseIP(endStr).To4()
			if a == nil || b == nil || ipToInt(b) < ipToInt(a) {
				return nil, fmt.Errorf("%q no es un rango valido (ej. 10.0.6.1-50)", t)
			}
			for ip := ipToInt(a); ip <= ipToInt(b); ip++ {
				if !add(ip) {
					return out, nil
				}
			}
		default:
			ip := net.ParseIP(t).To4()
			if ip == nil {
				return nil, fmt.Errorf("%q no es una IP valida", t)
			}
			if !add(ipToInt(ip)) {
				return out, nil
			}
		}
	}
	return out, nil
}

// ParseUnitIDs lee "1-10", "1,2,5" o una mezcla. Vacio = solo el 1. Maximo 32 IDs por host.
func ParseUnitIDs(s string) ([]int, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return []int{1}, nil
	}
	var out []int
	for _, part := range strings.Split(s, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		lo, hi := part, part
		if i := strings.Index(part, "-"); i >= 0 {
			lo, hi = part[:i], part[i+1:]
		}
		a, errA := strconv.Atoi(strings.TrimSpace(lo))
		b, errB := strconv.Atoi(strings.TrimSpace(hi))
		if errA != nil || errB != nil || a < 0 || b > 255 || b < a {
			return nil, fmt.Errorf("unit IDs invalidos %q (ej. 1-10 o 1,2,5)", part)
		}
		for u := a; u <= b; u++ {
			out = append(out, u)
			if len(out) >= 32 {
				return out, nil
			}
		}
	}
	return out, nil
}

func ipToInt(ip net.IP) uint32 { return binary.BigEndian.Uint32(ip.To4()) }

func intToIP(n uint32) string {
	b := make(net.IP, 4)
	binary.BigEndian.PutUint32(b, n)
	return b.String()
}
