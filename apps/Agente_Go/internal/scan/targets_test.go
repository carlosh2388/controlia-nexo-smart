package scan

import (
	"reflect"
	"testing"
)

func TestExpandTargets(t *testing.T) {
	cases := []struct {
		in   []string
		want []string
	}{
		{[]string{"10.0.6.26"}, []string{"10.0.6.26"}},
		{[]string{"10.0.6.1-3"}, []string{"10.0.6.1", "10.0.6.2", "10.0.6.3"}},
		{[]string{"10.0.6.254-10.0.7.1"}, []string{"10.0.6.254", "10.0.6.255", "10.0.7.0", "10.0.7.1"}},
		// Red /30: sin direccion de red ni broadcast.
		{[]string{"10.0.6.0/30"}, []string{"10.0.6.1", "10.0.6.2"}},
		// Duplicados se cuentan una vez.
		{[]string{"10.0.6.1", "10.0.6.1-2"}, []string{"10.0.6.1", "10.0.6.2"}},
	}
	for _, c := range cases {
		got, err := ExpandTargets(c.in, 100)
		if err != nil {
			t.Fatalf("%v: %v", c.in, err)
		}
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("%v: got %v, want %v", c.in, got, c.want)
		}
	}
}

func TestExpandTargetsLimitAndErrors(t *testing.T) {
	got, err := ExpandTargets([]string{"10.0.0.0/16"}, 5)
	if err != nil || len(got) != 5 {
		t.Fatalf("limite: got %d (%v), want 5", len(got), err)
	}
	for _, bad := range []string{"10.0.6", "10.0.6.9-3", "10.0.0.0/8", "hospital"} {
		if _, err := ExpandTargets([]string{bad}, 10); err == nil {
			t.Errorf("%q deberia ser invalido", bad)
		}
	}
}

func TestParseUnitIDs(t *testing.T) {
	got, err := ParseUnitIDs("1-3, 7")
	if err != nil || !reflect.DeepEqual(got, []int{1, 2, 3, 7}) {
		t.Fatalf("got %v (%v)", got, err)
	}
	if got, _ := ParseUnitIDs(""); !reflect.DeepEqual(got, []int{1}) {
		t.Errorf("vacio: got %v, want [1]", got)
	}
	if got, _ := ParseUnitIDs("0-255"); len(got) != 32 {
		t.Errorf("tope: got %d, want 32", len(got))
	}
	if _, err := ParseUnitIDs("5-2"); err == nil {
		t.Error("5-2 deberia ser invalido")
	}
}
